/**
 * Cloudflare Worker for Sem Desperdício (NFC-e QR Code Reader).
 * Serves static frontend assets and handles POST /api/parse_nfce(.php)
 * by fetching and parsing Brazilian SEFAZ NFC-e pages.
 */

const STATIC_ASSETS = __STATIC_ASSETS_PLACEHOLDER__;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/parse_nfce.php' || path === '/api/parse_nfce') {
      return handleParseNfce(request);
    }

    const assetKey = path === '/' ? '/index.html' : path;
    const asset = STATIC_ASSETS[assetKey];
    if (asset) {
      return new Response(asset.body, {
        headers: {
          'Content-Type': asset.type,
          'Cache-Control': assetKey === '/index.html' ? 'no-cache' : 'public, max-age=3600',
          'X-Content-Type-Options': 'nosniff',
        },
      });
    }

    if (env && env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not Found', { status: 404 });
  },
};

async function handleParseNfce(request) {
  if (request.method !== 'POST') {
    return jsonResponse({ success: false, error: 'Método não permitido. Use POST.' }, 405);
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return jsonResponse({ success: false, error: 'JSON inválido.' }, 400);
  }

  const targetUrl = String(payload?.url || '').trim();
  let parsedUrl;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    return jsonResponse(
      { success: false, error: 'URL inválida. Escaneie um QR Code de cupom fiscal válido.' },
      400
    );
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return jsonResponse({ success: false, error: 'Apenas URLs HTTP/HTTPS são suportadas.' }, 400);
  }

  if (isBlockedHost(parsedUrl.hostname)) {
    return jsonResponse({ success: false, error: 'Host não permitido por motivos de segurança.' }, 403);
  }

  let html = '';
  let finalUrl = targetUrl;
  try {
    const resp = await fetch(targetUrl, {
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
      },
    });

    if (!resp.ok) {
      return jsonResponse(
        { success: false, error: `O portal da SEFAZ retornou erro HTTP ${resp.status}.` },
        502
      );
    }

    finalUrl = resp.url || targetUrl;
    const buf = await resp.arrayBuffer();
    const ct = resp.headers.get('content-type') || '';
    const isLatin1 = /iso-8859-1|windows-1252/i.test(ct);
    html = new TextDecoder(isLatin1 ? 'iso-8859-1' : 'utf-8').decode(buf);
    if (!isLatin1 && /charset=["']?(?:iso-8859-1|windows-1252)/i.test(html.slice(0, 2000))) {
      html = new TextDecoder('iso-8859-1').decode(buf);
    }
  } catch (err) {
    return jsonResponse(
      { success: false, error: `Erro ao acessar o portal da SEFAZ: ${err.message || 'falha de rede'}` },
      502
    );
  }

  const parsed = await parseNfceHtml(html, finalUrl);
  if (!parsed.itens.length) {
    return jsonResponse(
      {
        success: false,
        error:
          'Não foi possível extrair os produtos desta página. Verifique se o QR Code é de uma NFC-e válida ou se a SEFAZ do estado exige captcha.',
        debug: { estabelecimento: parsed.estabelecimento, finalUrl },
      },
      422
    );
  }

  return jsonResponse({ success: true, data: parsed }, 200);
}

function isBlockedHost(hostname) {
  const h = hostname.toLowerCase();
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(h)) return true;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h)) return true;
  return false;
}

async function parseNfceHtml(html, sourceUrl) {
  let estabelecimento = '';
  const itemRows = [];
  let currentRow = null;
  const totalRows = [];
  let currentTotalRow = null;

  const rewriter = new HTMLRewriter()
    .on('#u20, .txtTopo, .NFCE-estab', {
      element(el) {
        if (!estabelecimento) {
          currentCapturingEstab = true;
          el.onEndTag(() => {
            currentCapturingEstab = false;
          });
        }
      },
      text(chunk) {
        if (currentCapturingEstab) {
          estabelecimento += chunk.text;
        }
      },
    })
    .on('table#tabResult tr, table.tabResult tr, tr[id^="Item"]', {
      element(el) {
        const row = { nome: '', codigo: '', qtd: '', un: '', vlUnit: '', vlTotal: '' };
        currentRow = row;
        el.onEndTag(() => {
          itemRows.push(row);
          if (currentRow === row) currentRow = null;
        });
      },
    })
    .on('table#tabResult tr .txtTit, table#tabResult tr .txtTit2, table.tabResult tr .txtTit, table.tabResult tr .txtTit2, tr[id^="Item"] .txtTit, tr[id^="Item"] .txtTit2', {
      text(chunk) {
        if (currentRow) currentRow.nome += chunk.text;
      },
    })
    .on('table#tabResult tr .RCod, table.tabResult tr .RCod, tr[id^="Item"] .RCod', {
      text(chunk) {
        if (currentRow) currentRow.codigo += chunk.text;
      },
    })
    .on('table#tabResult tr .Rqtd, table.tabResult tr .Rqtd, tr[id^="Item"] .Rqtd', {
      text(chunk) {
        if (currentRow) currentRow.qtd += chunk.text;
      },
    })
    .on('table#tabResult tr .RUN, table.tabResult tr .RUN, tr[id^="Item"] .RUN', {
      text(chunk) {
        if (currentRow) currentRow.un += chunk.text;
      },
    })
    .on('table#tabResult tr .RvlUnit, table.tabResult tr .RvlUnit, tr[id^="Item"] .RvlUnit', {
      text(chunk) {
        if (currentRow) currentRow.vlUnit += chunk.text;
      },
    })
    .on('table#tabResult tr .valor, table.tabResult tr .valor, tr[id^="Item"] .valor', {
      text(chunk) {
        if (currentRow) currentRow.vlTotal += chunk.text;
      },
    })
    .on('#totalNota div[id*="linhaTotal"], #totalNota tr, div[id*="linhaTotal"]', {
      element(el) {
        const tRow = { text: '' };
        currentTotalRow = tRow;
        el.onEndTag(() => {
          totalRows.push(tRow.text);
          if (currentTotalRow === tRow) currentTotalRow = null;
        });
      },
      text(chunk) {
        if (currentTotalRow) currentTotalRow.text += chunk.text;
      },
    });

  let currentCapturingEstab = false;
  await rewriter.transform(new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })).text();

  const itens = [];
  for (const r of itemRows) {
    const nome = cleanText(r.nome);
    if (!nome) continue;

    const codigoMatch = cleanText(r.codigo).match(/(\d+)/);
    const codigo = codigoMatch ? codigoMatch[1] : '';
    let quantidade = parseBrNumber(cleanText(r.qtd).replace(/^.*?:/, '') || '1');
    if (quantidade <= 0) quantidade = 1;

    const unidade = cleanText(r.un).replace(/^.*?:/, '').trim().toUpperCase() || 'UN';
    let valorUnitario = parseBrNumber(cleanText(r.vlUnit).replace(/^.*?:/, ''));
    const valorTotal = parseBrNumber(cleanText(r.vlTotal));

    if (valorUnitario <= 0 && valorTotal > 0 && quantidade > 0) {
      valorUnitario = Math.round((valorTotal / quantidade) * 100) / 100;
    }

    itens.push({
      nome,
      codigo,
      quantidade,
      unidade,
      valorUnitario: Math.round(valorUnitario * 100) / 100,
      valorTotal: Math.round(valorTotal * 100) / 100,
    });
  }

  const somaItens = itens.reduce((acc, i) => acc + i.valorTotal, 0);

  let valorTotal = 0;
  let fallbackMonetary = 0;
  let qtdItensInformada = null;

  for (const rawText of totalRows) {
    const text = cleanText(rawText);
    const qtdMatch = text.match(/qtd\.?\s*total\s*(?:de\s*)?itens\s*:?\s*(\d+)/i);
    if (qtdMatch) {
      qtdItensInformada = parseInt(qtdMatch[1], 10);
      continue;
    }
    if (/(?:valor\s+a\s+pagar|valor\s+total|total\s+r\$)/i.test(text)) {
      const m = text.match(/(\d{1,3}(?:\.\d{3})*,\d{2})/);
      if (m) {
        const val = parseBrNumber(m[1]);
        if (/valor\s+a\s+pagar/i.test(text)) {
          valorTotal = val;
          break;
        }
        fallbackMonetary = val;
      }
    }
  }

  if (valorTotal <= 0) valorTotal = fallbackMonetary;
  if (valorTotal <= 0) {
    const m = html.match(/Valor\s+(?:a\s+pagar|total)\s*R?\$?\s*:?\s*(?:<[^>]+>\s*)*(\d{1,3}(?:\.\d{3})*,\d{2})/i);
    if (m) valorTotal = parseBrNumber(m[1]);
  }
  if (valorTotal <= 0 && somaItens > 0) valorTotal = somaItens;

  const cnpjMatch = html.match(/CNPJ\s*:?\s*([\d.\-\/]{14,18})/i);
  const dataMatch = html.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/);

  return {
    estabelecimento: cleanText(estabelecimento) || 'Supermercado / Estabelecimento',
    cnpj: cnpjMatch ? cnpjMatch[1].trim() : '',
    data: dataMatch ? dataMatch[1].trim() : '',
    valorTotal: Math.round(valorTotal * 100) / 100,
    somaItens: Math.round(somaItens * 100) / 100,
    qtdItensInformada,
    url: sourceUrl,
    itens,
  };
}

function parseBrNumber(value) {
  const cleaned = String(value || '').replace(/[^\d,.\-]/g, '');
  if (!cleaned) return 0;
  if (cleaned.includes(',')) {
    return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
  }
  return parseFloat(cleaned) || 0;
}

function cleanText(text) {
  return String(text || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
