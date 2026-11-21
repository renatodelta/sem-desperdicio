<?php
/**
 * Backend proxy & parser for Brazilian NFC-e (Cupom Fiscal) QR Code URLs.
 * Fetches the SEFAZ receipt page (avoiding browser CORS restrictions) and
 * extracts store metadata and purchased items as JSON.
 */

declare(strict_types=1);

header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['success' => false, 'error' => 'Método não permitido. Use POST.']);
    exit;
}

$rawBody = file_get_contents('php://input');
$payload = json_decode($rawBody ?: '', true);
$url = trim((string)($payload['url'] ?? ''));

if ($url === '' || !filter_var($url, FILTER_VALIDATE_URL)) {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'URL inválida. Escaneie um QR Code de cupom fiscal válido.']);
    exit;
}

$parts = parse_url($url);
$scheme = strtolower($parts['scheme'] ?? '');
$host = strtolower($parts['host'] ?? '');

if (!in_array($scheme, ['http', 'https'], true) || $host === '') {
    http_response_code(400);
    echo json_encode(['success' => false, 'error' => 'Apenas URLs HTTP/HTTPS são suportadas.']);
    exit;
}

// Basic SSRF protection: block localhost and private/reserved IP ranges
if (isBlockedHost($host)) {
    http_response_code(403);
    echo json_encode(['success' => false, 'error' => 'Host não permitido por motivos de segurança.']);
    exit;
}

$fetchResult = fetchReceiptHtml($url);
if (!$fetchResult['ok']) {
    http_response_code(502);
    echo json_encode(['success' => false, 'error' => $fetchResult['error']]);
    exit;
}

$parsed = parseNfceHtml($fetchResult['html'], $fetchResult['finalUrl']);

if (empty($parsed['itens'])) {
    http_response_code(422);
    echo json_encode([
        'success' => false,
        'error' => 'Não foi possível extrair os produtos desta página. Verifique se o QR Code é de uma NFC-e válida ou se a SEFAZ do estado exige captcha.',
        'debug' => [
            'estabelecimento' => $parsed['estabelecimento'],
            'finalUrl' => $fetchResult['finalUrl'],
        ],
    ]);
    exit;
}

echo json_encode([
    'success' => true,
    'data' => $parsed,
], JSON_UNESCAPED_UNICODE);

/**
 * Checks if a hostname resolves to a private, loopback, or reserved IP.
 */
function isBlockedHost(string $host): bool
{
    if (in_array($host, ['localhost', '127.0.0.1', '::1', '0.0.0.0'], true)) {
        return true;
    }

    $ips = @gethostbynamel($host);
    if ($ips === false) {
        return false; // Let cURL fail naturally if DNS doesn't resolve
    }

    foreach ($ips as $ip) {
        if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
            return true;
        }
    }

    return false;
}

/**
 * Fetches the HTML content of the NFC-e URL using cURL.
 */
function fetchReceiptHtml(string $url): array
{
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_MAXREDIRS => 5,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
        CURLOPT_SSL_VERIFYHOST => 2,
        CURLOPT_ENCODING => '',
        CURLOPT_USERAGENT => 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        CURLOPT_HTTPHEADER => [
            'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language: pt-BR,pt;q=0.9,en;q=0.8',
        ],
    ]);

    $html = curl_exec($ch);
    $curlErr = curl_error($ch);
    $httpCode = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $finalUrl = (string)curl_getinfo($ch, CURLINFO_EFFECTIVE_URL);
    curl_close($ch);

    if ($html === false || $html === '') {
        return [
            'ok' => false,
            'error' => 'Erro ao acessar o portal da SEFAZ: ' . ($curlErr ?: 'resposta vazia'),
        ];
    }

    if ($httpCode >= 400) {
        return [
            'ok' => false,
            'error' => "O portal da SEFAZ retornou erro HTTP {$httpCode}.",
        ];
    }

    return [
        'ok' => true,
        'html' => $html,
        'finalUrl' => $finalUrl ?: $url,
    ];
}

/**
 * Parses HTML from Brazilian SEFAZ NFC-e portals into structured receipt data.
 */
function parseNfceHtml(string $html, string $sourceUrl): array
{
    // Normalize encoding to UTF-8 for DOMDocument
    $encoding = mb_detect_encoding($html, ['UTF-8', 'ISO-8859-1', 'Windows-1252'], true) ?: 'UTF-8';
    if ($encoding !== 'UTF-8') {
        $html = mb_convert_encoding($html, 'UTF-8', $encoding);
    }

    // Strip <script> and <style> blocks so malformed JS cannot break DOMDocument table parsing
    $cleanHtml = preg_replace('/<(script|style)\b[^>]*>.*?<\/\1>/is', '', $html) ?? $html;

    $dom = new DOMDocument();
    libxml_use_internal_errors(true);
    $dom->loadHTML('<?xml encoding="UTF-8">' . $cleanHtml, LIBXML_NOWARNING | LIBXML_NOERROR | LIBXML_PARSEHUGE);
    libxml_clear_errors();

    $xpath = new DOMXPath($dom);

    $estabelecimento = extractFirstText($xpath, [
        '//*[@id="u20"]',
        '//*[contains(@class, "txtTopo")]',
        '//*[contains(@class, "NFCE-estab")]',
        '//div[contains(@id, "conteudo")]//h2',
        '//h4',
    ]) ?: 'Supermercado / Estabelecimento';

    $cnpj = extractRegex($cleanHtml, '/CNPJ\s*:?\s*([\d.\-\/]{14,18})/i') ?? '';
    $dataEmissao = extractRegex($cleanHtml, '/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/') ?? '';

    $itens = extractItemsStandard($xpath);

    // Fallback for alternative SEFAZ table structures (e.g. SAT SP or older portals)
    if (empty($itens)) {
        $itens = extractItemsGenericTable($xpath);
    }

    $somaItens = array_reduce($itens, fn(float $carry, array $item) => $carry + $item['valorTotal'], 0.0);
    $valorTotal = extractReceiptTotal($xpath, $cleanHtml);

    if ($valorTotal <= 0 && $somaItens > 0) {
        $valorTotal = $somaItens;
    }

    $qtdItensInformada = extractExpectedItemCount($xpath, $cleanHtml);

    return [
        'estabelecimento' => cleanText($estabelecimento),
        'cnpj' => $cnpj,
        'data' => $dataEmissao,
        'valorTotal' => round($valorTotal, 2),
        'somaItens' => round($somaItens, 2),
        'qtdItensInformada' => $qtdItensInformada,
        'url' => $sourceUrl,
        'itens' => $itens,
    ];
}

/**
 * Extracts the monetary total from #totalNota / #linhaTotal, avoiding "Qtd. total de itens".
 */
function extractReceiptTotal(DOMXPath $xpath, string $html): float
{
    // 1. Prefer explicit "Valor a pagar" or "Valor total" rows inside #totalNota
    $rows = $xpath->query('//*[@id="totalNota"]//div[contains(@id, "linhaTotal")] | //*[@id="totalNota"]//tr | //div[contains(@id, "linhaTotal")]');
    if ($rows) {
        $fallbackMonetary = 0.0;
        foreach ($rows as $row) {
            $text = cleanText($row->textContent ?? '');
            if (preg_match('/qtd\.?\s*total/i', $text)) {
                continue;
            }
            if (preg_match('/(?:valor\s+a\s+pagar|valor\s+total|total\s+r\$)/i', $text)) {
                $numNode = $xpath->query('.//*[contains(@class, "totalNumb")]', $row);
                $valStr = ($numNode && $numNode->length > 0) ? $numNode->item(0)->textContent : $text;
                if (preg_match('/(\d{1,3}(?:\.\d{3})*,\d{2})/', $valStr, $m)) {
                    $val = parseBrNumber($m[1]);
                    if (preg_match('/valor\s+a\s+pagar/i', $text)) {
                        return $val;
                    }
                    $fallbackMonetary = $val;
                }
            }
        }
        if ($fallbackMonetary > 0) {
            return $fallbackMonetary;
        }
    }

    // 2. Fallback to .totalNumb.txtMax
    $txtMax = extractFirstText($xpath, [
        '//*[contains(@class, "totalNumb") and contains(@class, "txtMax")]',
    ]);
    if ($txtMax !== '' && str_contains($txtMax, ',')) {
        return parseBrNumber($txtMax);
    }

    // 3. Regex fallback on HTML text
    if (preg_match('/Valor\s+(?:a\s+pagar|total)\s*R?\$?\s*:?\s*(?:<[^>]+>\s*)*(\d{1,3}(?:\.\d{3})*,\d{2})/i', $html, $m)) {
        return parseBrNumber($m[1]);
    }

    return 0.0;
}

/**
 * Extracts the expected item count ("Qtd. total de itens") if present on the SEFAZ page.
 */
function extractExpectedItemCount(DOMXPath $xpath, string $html): ?int
{
    $rows = $xpath->query('//*[@id="totalNota"]//div[contains(@id, "linhaTotal")] | //*[@id="totalNota"]//tr');
    if ($rows) {
        foreach ($rows as $row) {
            $text = cleanText($row->textContent ?? '');
            if (preg_match('/qtd\.?\s*total\s*(?:de\s*)?itens\s*:?\s*(\d+)/i', $text, $m)) {
                return (int)$m[1];
            }
        }
    }
    if (preg_match('/Qtd\.?\s*total\s*(?:de\s*)?itens\s*:?\s*(?:<[^>]+>\s*)*(\d+)/i', $html, $m)) {
        return (int)$m[1];
    }
    return null;
}

/**
 * Extracts items from the standard Brazilian NFC-e layout (#tabResult tr or Item+N rows).
 */
function extractItemsStandard(DOMXPath $xpath): array
{
    $rows = $xpath->query('//table[@id="tabResult"]//tr | //table[contains(@class, "tabResult")]//tr | //tr[starts-with(@id, "Item")]');
    if (!$rows || $rows->length === 0) {
        return [];
    }

    $itens = [];
    $seenNodes = [];
    foreach ($rows as $row) {
        $hash = spl_object_id($row);
        if (isset($seenNodes[$hash])) {
            continue;
        }
        $seenNodes[$hash] = true;

        $nome = extractFirstText($xpath, [
            './/*[contains(@class, "txtTit")]',
            './/*[contains(@class, "txtTit2")]',
        ], $row);

        if ($nome === '') {
            continue;
        }

        $codigoRaw = extractFirstText($xpath, ['.//*[contains(@class, "RCod")]'], $row);
        $qtdRaw = extractFirstText($xpath, ['.//*[contains(@class, "Rqtd")]'], $row);
        $unRaw = extractFirstText($xpath, ['.//*[contains(@class, "RUN")]'], $row);
        $vlUnitRaw = extractFirstText($xpath, ['.//*[contains(@class, "RvlUnit")]'], $row);
        $vlTotalRaw = extractFirstText($xpath, ['.//*[contains(@class, "valor")]'], $row);

        // Fallback if .valor class is missing: check last td
        if ($vlTotalRaw === '') {
            $tds = $xpath->query('./td', $row);
            if ($tds && $tds->length > 1) {
                $vlTotalRaw = cleanText($tds->item($tds->length - 1)->textContent ?? '');
            }
        }

        $codigo = extractRegex($codigoRaw, '/(\d+)/') ?? '';
        $quantidade = parseBrNumber(preg_replace('/^.*?:/', '', $qtdRaw) ?: '1');
        if ($quantidade <= 0) {
            $quantidade = 1.0;
        }

        $unidade = cleanText(preg_replace('/^.*?:/', '', $unRaw));
        if ($unidade === '') {
            $unidade = 'UN';
        }

        $valorUnitario = parseBrNumber(preg_replace('/^.*?:/', '', $vlUnitRaw));
        $valorTotal = parseBrNumber($vlTotalRaw);

        if ($valorUnitario <= 0 && $valorTotal > 0 && $quantidade > 0) {
            $valorUnitario = round($valorTotal / $quantidade, 2);
        }

        $itens[] = [
            'nome' => cleanText($nome),
            'codigo' => $codigo,
            'quantidade' => $quantidade,
            'unidade' => strtoupper($unidade),
            'valorUnitario' => round($valorUnitario, 2),
            'valorTotal' => round($valorTotal, 2),
        ];
    }

    return $itens;
}

/**
 * Fallback parser for tables that list products in columns.
 */
function extractItemsGenericTable(DOMXPath $xpath): array
{
    $rows = $xpath->query('//table//tr[td]');
    if (!$rows || $rows->length === 0) {
        return [];
    }

    $itens = [];
    foreach ($rows as $row) {
        $cells = $xpath->query('./td', $row);
        if (!$cells || $cells->length < 3) {
            continue;
        }

        $texts = [];
        foreach ($cells as $cell) {
            $texts[] = cleanText($cell->textContent);
        }

        // Heuristic: look for a row with a product description and at least one monetary value
        $joined = implode(' ', $texts);
        if (preg_match('/^(código|descrição|item|produto|total|troco|valor\s+a\s+pagar)/i', $joined)) {
            continue;
        }

        $hasPrice = false;
        $prices = [];
        foreach ($texts as $t) {
            if (preg_match('/^\s*(?:R\$\s*)?\d{1,3}(?:\.\d{3})*,\d{2}\s*$/', $t)) {
                $hasPrice = true;
                $prices[] = parseBrNumber($t);
            }
        }

        if (!$hasPrice) {
            continue;
        }

        // Pick longest non-numeric text as product name
        $nome = '';
        foreach ($texts as $t) {
            if (!preg_match('/^[\d.,\sR$%]+$/', $t) && mb_strlen($t) > mb_strlen($nome)) {
                $nome = $t;
            }
        }

        if ($nome === '' || mb_strlen($nome) < 3) {
            continue;
        }

        $valorTotal = end($prices) ?: 0.0;
        $valorUnitario = count($prices) > 1 ? $prices[0] : $valorTotal;

        $itens[] = [
            'nome' => $nome,
            'codigo' => '',
            'quantidade' => 1.0,
            'unidade' => 'UN',
            'valorUnitario' => round($valorUnitario, 2),
            'valorTotal' => round($valorTotal, 2),
        ];
    }

    return $itens;
}

function extractFirstText(DOMXPath $xpath, array $queries, ?DOMNode $context = null): string
{
    foreach ($queries as $q) {
        $nodes = $xpath->query($q, $context);
        if ($nodes && $nodes->length > 0) {
            $text = cleanText($nodes->item(0)->textContent ?? '');
            if ($text !== '') {
                return $text;
            }
        }
    }
    return '';
}

function extractRegex(string $subject, string $pattern): ?string
{
    if (preg_match($pattern, $subject, $matches)) {
        return trim($matches[1]);
    }
    return null;
}

function parseBrNumber(string $value): float
{
    $cleaned = preg_replace('/[^\d,.\-]/', '', $value);
    if ($cleaned === '' || $cleaned === null) {
        return 0.0;
    }
    // Brazilian format: 1.234,56 -> 1234.56
    if (str_contains($cleaned, ',')) {
        $cleaned = str_replace('.', '', $cleaned);
        $cleaned = str_replace(',', '.', $cleaned);
    }
    return (float)$cleaned;
}

function cleanText(string $text): string
{
    $text = html_entity_decode($text, ENT_QUOTES | ENT_HTML5, 'UTF-8');
    $text = preg_replace('/\s+/u', ' ', $text) ?? $text;
    return trim($text);
}
