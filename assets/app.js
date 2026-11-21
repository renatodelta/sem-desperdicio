(() => {
  const STORAGE_KEY = 'sem_desperdicio_history_v1';

  const els = {
    statusBanner: document.getElementById('status-banner'),
    httpsWarning: document.getElementById('https-warning'),
    qrReader: document.getElementById('qr-reader'),
    btnToggleCamera: document.getElementById('btn-toggle-camera'),
    qrFileInput: document.getElementById('qr-file-input'),
    manualUrlForm: document.getElementById('manual-url-form'),
    manualUrlInput: document.getElementById('manual-url-input'),
    btnDemo: document.getElementById('btn-demo'),
    btnTogglePaste: document.getElementById('btn-toggle-paste'),
    captchaFallback: document.getElementById('captcha-fallback'),
    btnOpenSefaz: document.getElementById('btn-open-sefaz'),
    pasteReceiptInput: document.getElementById('paste-receipt-input'),
    btnParsePasted: document.getElementById('btn-parse-pasted'),
    btnGoScan: document.getElementById('btn-go-scan'),
    emptyProducts: document.getElementById('empty-products'),
    receiptView: document.getElementById('receipt-view'),
    receiptStore: document.getElementById('receipt-store'),
    receiptMeta: document.getElementById('receipt-meta'),
    receiptTotal: document.getElementById('receipt-total'),
    receiptCount: document.getElementById('receipt-count'),
    receiptSourceLink: document.getElementById('receipt-source-link'),
    receiptWarning: document.getElementById('receipt-warning'),
    scanProgress: document.getElementById('scan-progress'),
    stepQr: document.getElementById('step-qr'),
    stepSefaz: document.getElementById('step-sefaz'),
    stepDone: document.getElementById('step-done'),
    productSearch: document.getElementById('product-search'),
    productList: document.getElementById('product-list'),
    historyEmpty: document.getElementById('history-empty'),
    historyList: document.getElementById('history-list'),
    btnClearHistory: document.getElementById('btn-clear-history'),
    navBtns: document.querySelectorAll('.nav-btn'),
    tabPanels: document.querySelectorAll('.tab-panel'),
  };

  let html5QrCode = null;
  let isCameraRunning = false;
  let isFetching = false;
  let hasScannedCurrentSession = false;
  let lastScannedUrl = '';
  let currentReceipt = null;

  // Warn if running on non-localhost HTTP (mobile browsers block camera access without HTTPS)
  if (location.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(location.hostname)) {
    els.httpsWarning.classList.remove('hidden');
  }

  // Tab navigation
  function switchTab(tabName) {
    els.navBtns.forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });
    els.tabPanels.forEach((panel) => {
      panel.classList.toggle('active', panel.id === `tab-${tabName}`);
    });
  }

  els.navBtns.forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  els.btnGoScan.addEventListener('click', () => switchTab('scan'));

  // Feedback helpers (vibration + subtle beep + progress steps)
  function vibratePhone(pattern = [100, 50, 100]) {
    try {
      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(pattern);
      }
    } catch {
      // Ignore if unsupported
    }
  }

  function playScanBeep() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(880, ctx.currentTime);
      gain.gain.setValueAtTime(0.08, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.12);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
    } catch {
      // Ignore audio errors
    }
  }

  function setStep(el, state, text) {
    el.className = `progress-step ${state}`;
    const iconEl = el.querySelector('.step-icon');
    const textEl = el.querySelector('.step-text');
    if (iconEl) {
      iconEl.textContent = state === 'done' ? '✅' : state === 'error' ? '❌' : '⏳';
    }
    if (textEl && text) {
      textEl.textContent = text;
    }
  }

  function resetProgress(show = false) {
    els.scanProgress.classList.toggle('hidden', !show);
    setStep(els.stepQr, 'active', 'Aponte a câmera para o QR Code...');
    setStep(els.stepSefaz, '', 'Aguardando leitura para consultar a SEFAZ');
    setStep(els.stepDone, '', 'Aguardando lista de produtos');
  }

  // Status banner helper
  function showStatus(message, type = 'info') {
    els.statusBanner.textContent = message;
    els.statusBanner.className = `status-banner ${type}`;
  }

  function hideStatus() {
    els.statusBanner.classList.add('hidden');
  }

  // Camera Scanner
  async function startCamera() {
    if (typeof Html5Qrcode === 'undefined') {
      showStatus('Biblioteca de QR Code não carregou. Verifique a internet ou use o link manual.', 'error');
      return;
    }

    hideStatus();
    resetProgress(true);
    hasScannedCurrentSession = false;

    if (!html5QrCode) {
      const qrFormats =
        typeof Html5QrcodeSupportedFormats !== 'undefined'
          ? [Html5QrcodeSupportedFormats.QR_CODE]
          : undefined;
      html5QrCode = new Html5Qrcode('qr-reader', {
        formatsToSupport: qrFormats,
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
    }

    const scannerConfig = {
      fps: 24,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(180, Math.floor(minEdge * 0.72));
        return { width: size, height: size };
      },
      videoConstraints: {
        facingMode: 'environment',
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    };

    try {
      els.btnToggleCamera.disabled = true;
      els.btnToggleCamera.textContent = 'Abrindo...';

      await html5QrCode.start(
        { facingMode: 'environment' },
        scannerConfig,
        (decodedText) => {
          if (hasScannedCurrentSession) return;
          hasScannedCurrentSession = true;

          // Immediate tactile & visual feedback so user knows they can lower the phone
          vibratePhone([100, 50, 100]);
          playScanBeep();
          setStep(els.stepQr, 'done', 'QR Code lido!');
          setStep(els.stepSefaz, 'active', 'Consultando a NFC-e no site da SEFAZ...');
          showStatus('QR Code lido! Consultando a NFC-e no site da SEFAZ...', 'info');

          stopCamera();
          handleQrDetected(decodedText, true);
        },
        () => {
          // Ignore per-frame scan misses
        }
      );

      isCameraRunning = true;
      els.btnToggleCamera.textContent = 'Parar Câmera';
    } catch (err) {
      resetProgress(false);
      showStatus(
        'Não foi possível abrir a câmera. Verifique as permissões ou use "Ler QR de uma Foto".',
        'error'
      );
      els.btnToggleCamera.textContent = 'Abrir Câmera';
    } finally {
      els.btnToggleCamera.disabled = false;
    }
  }

  async function stopCamera() {
    if (!html5QrCode || !isCameraRunning) return;
    try {
      await html5QrCode.stop();
    } catch {
      // Ignore stop errors
    }
    isCameraRunning = false;
    els.btnToggleCamera.textContent = 'Abrir Câmera';
    els.qrReader.innerHTML = `
      <div class="qr-placeholder">
        <span>📷</span>
        <p>Aponte a câmera para o QR Code do cupom fiscal</p>
      </div>
    `;
  }

  els.btnToggleCamera.addEventListener('click', () => {
    if (isCameraRunning) {
      resetProgress(false);
      stopCamera();
    } else {
      startCamera();
    }
  });

  // Scan QR from uploaded/captured image
  els.qrFileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (typeof Html5Qrcode === 'undefined') {
      showStatus('Biblioteca de QR Code não carregou.', 'error');
      return;
    }

    if (isCameraRunning) {
      await stopCamera();
    }

    resetProgress(true);
    setStep(els.stepQr, 'active', 'Procurando QR Code na foto...');
    showStatus('Lendo QR Code da imagem...', 'info');
    try {
      const fileScanner = new Html5Qrcode('qr-file-reader', {
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
      const decodedText = await fileScanner.scanFile(file, false);
      vibratePhone([100, 50, 100]);
      setStep(els.stepQr, 'done', 'QR Code lido!');
      handleQrDetected(decodedText, true);
    } catch {
      setStep(els.stepQr, 'error', 'Nenhum QR Code encontrado na foto.');
      showStatus('Nenhum QR Code encontrado nesta imagem. Tente uma foto mais nítida.', 'error');
    } finally {
      els.qrFileInput.value = '';
    }
  });

  // Manual URL form
  els.manualUrlForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const url = els.manualUrlInput.value.trim();
    if (url) {
      resetProgress(true);
      setStep(els.stepQr, 'done', 'Link informado!');
      handleQrDetected(url, true);
    }
  });

  // Handle QR Code URL -> call PHP backend
  async function handleQrDetected(rawText, fromProgress = false) {
    if (isFetching) return;
    const url = rawText.trim();

    if (!/^https?:\/\//i.test(url)) {
      if (fromProgress) {
        setStep(els.stepQr, 'error', 'O QR Code não é um link de cupom fiscal.');
      }
      showStatus('O QR Code lido não contém um link HTTP/HTTPS de cupom fiscal.', 'error');
      return;
    }

    isFetching = true;
    lastScannedUrl = url;
    els.captchaFallback.classList.add('hidden');
    els.scanProgress.classList.remove('hidden');
    setStep(els.stepQr, 'done', 'QR Code lido!');
    setStep(els.stepSefaz, 'active', 'Consultando a NFC-e no site da SEFAZ...');
    setStep(els.stepDone, '', 'Extraindo produtos...');
    showStatus('QR Code lido! Consultando a NFC-e no site da SEFAZ...', 'info');

    try {
      const response = await fetch('api/parse_nfce.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        setStep(els.stepSefaz, 'error', 'SEFAZ pediu CAPTCHA ou bloqueou a consulta.');
        showStatus(result.error || 'Falha ao ler os produtos deste cupom.', 'error');
        showCaptchaFallback(url);
        return;
      }

      const receipt = result.data;
      setStep(els.stepSefaz, 'done', 'NFC-e consultada com sucesso!');
      setStep(els.stepDone, 'done', `Concluído! ${receipt.itens.length} produto(s) listado(s).`);

      saveToHistory(receipt);
      renderReceipt(receipt);
      showStatus(`Concluído! ${receipt.itens.length} produto(s) carregado(s).`, 'success');
      switchTab('products');
    } catch {
      setStep(els.stepSefaz, 'error', 'Erro de conexão com o servidor.');
      showStatus('Erro de conexão com o servidor. Você pode abrir o cupom no navegador abaixo.', 'error');
      showCaptchaFallback(url);
    } finally {
      isFetching = false;
    }
  }

  // Render receipt & product list
  function renderReceipt(receipt) {
    currentReceipt = receipt;
    els.emptyProducts.classList.add('hidden');
    els.receiptView.classList.remove('hidden');

    els.receiptStore.textContent = receipt.estabelecimento || 'Supermercado';
    const metaParts = [receipt.data, receipt.cnpj ? `CNPJ: ${receipt.cnpj}` : ''].filter(Boolean);
    els.receiptMeta.textContent = metaParts.join(' • ') || 'Cupom Fiscal Eletrônico';
    els.receiptTotal.textContent = formatBrl(receipt.valorTotal);
    els.receiptCount.textContent = `${receipt.itens.length} ${receipt.itens.length === 1 ? 'item' : 'itens'}`;

    if (receipt.qtdItensInformada && receipt.qtdItensInformada !== receipt.itens.length) {
      els.receiptWarning.textContent =
        `Atenção: o cupom informa ${receipt.qtdItensInformada} itens, mas foram extraídos ${receipt.itens.length}. Verifique no link da SEFAZ.`;
      els.receiptWarning.classList.remove('hidden');
    } else {
      els.receiptWarning.classList.add('hidden');
    }

    if (receipt.url && /^https?:\/\//i.test(receipt.url)) {
      els.receiptSourceLink.href = receipt.url;
      els.receiptSourceLink.classList.remove('hidden');
    } else {
      els.receiptSourceLink.classList.add('hidden');
    }

    els.productSearch.value = '';
    renderProductList(receipt.itens);
  }

  function renderProductList(items) {
    els.productList.innerHTML = '';

    if (!items.length) {
      const emptyLi = document.createElement('li');
      emptyLi.className = 'card empty-state';
      emptyLi.textContent = 'Nenhum produto encontrado com esse filtro.';
      els.productList.appendChild(emptyLi);
      return;
    }

    const fragment = document.createDocumentFragment();

    items.forEach((item) => {
      const li = document.createElement('li');
      li.className = 'product-item';

      const infoDiv = document.createElement('div');
      infoDiv.className = 'product-info';

      const nameEl = document.createElement('p');
      nameEl.className = 'product-name';
      nameEl.textContent = item.nome;

      const metaEl = document.createElement('div');
      metaEl.className = 'product-meta';
      const qtyStr = formatQty(item.quantidade);
      metaEl.textContent = `${qtyStr} ${item.unidade} × ${formatBrl(item.valorUnitario)}`;

      infoDiv.appendChild(nameEl);
      infoDiv.appendChild(metaEl);

      const priceDiv = document.createElement('div');
      priceDiv.className = 'product-price';
      const priceStrong = document.createElement('strong');
      priceStrong.textContent = formatBrl(item.valorTotal);
      priceDiv.appendChild(priceStrong);

      li.appendChild(infoDiv);
      li.appendChild(priceDiv);
      fragment.appendChild(li);
    });

    els.productList.appendChild(fragment);
  }

  els.productSearch.addEventListener('input', () => {
    if (!currentReceipt) return;
    const term = els.productSearch.value.trim().toLowerCase();
    const filtered = term
      ? currentReceipt.itens.filter((i) => i.nome.toLowerCase().includes(term))
      : currentReceipt.itens;
    renderProductList(filtered);
  });

  // History (localStorage)
  function getHistory() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    } catch {
      return [];
    }
  }

  function saveToHistory(receipt) {
    const history = getHistory();
    const entry = {
      ...receipt,
      savedAt: new Date().toISOString(),
    };
    const filtered = history.filter((h) => !(h.url && receipt.url && h.url === receipt.url));
    filtered.unshift(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(filtered.slice(0, 30)));
    renderHistory();
  }

  function renderHistory() {
    const history = getHistory();
    els.historyList.innerHTML = '';

    if (!history.length) {
      els.historyEmpty.classList.remove('hidden');
      els.btnClearHistory.classList.add('hidden');
      return;
    }

    els.historyEmpty.classList.add('hidden');
    els.btnClearHistory.classList.remove('hidden');

    history.forEach((receipt) => {
      const li = document.createElement('li');
      li.className = 'history-item';

      const left = document.createElement('div');
      const title = document.createElement('h3');
      title.textContent = receipt.estabelecimento || 'Supermercado';
      const sub = document.createElement('p');
      sub.textContent = receipt.data || 'Data não informada';
      left.appendChild(title);
      left.appendChild(sub);

      const right = document.createElement('div');
      right.className = 'history-right';
      const total = document.createElement('strong');
      total.textContent = formatBrl(receipt.valorTotal);
      const count = document.createElement('span');
      count.textContent = `${receipt.itens.length} itens`;
      right.appendChild(total);
      right.appendChild(count);

      li.appendChild(left);
      li.appendChild(right);

      li.addEventListener('click', () => {
        renderReceipt(receipt);
        switchTab('products');
      });

      els.historyList.appendChild(li);
    });
  }

  els.btnClearHistory.addEventListener('click', () => {
    localStorage.removeItem(STORAGE_KEY);
    renderHistory();
  });

  // Demo receipt
  els.btnDemo.addEventListener('click', () => {
    const demoReceipt = {
      estabelecimento: 'SUPERMERCADO EXEMPLO LTDA',
      cnpj: '12.345.678/0001-99',
      data: '21/11/2026 12:30:00',
      valorTotal: 87.45,
      url: '',
      itens: [
        { nome: 'ARROZ TIPO 1 5KG', codigo: '7891000100103', quantidade: 1, unidade: 'UN', valorUnitario: 28.90, valorTotal: 28.90 },
        { nome: 'FEIJAO CARIOCA 1KG', codigo: '7891000200201', quantidade: 2, unidade: 'UN', valorUnitario: 7.50, valorTotal: 15.00 },
        { nome: 'LEITE INTEGRAL UHT 1L', codigo: '7891000300309', quantidade: 4, unidade: 'UN', valorUnitario: 4.89, valorTotal: 19.56 },
        { nome: 'BANANA PRATA KG', codigo: '0000000001024', quantidade: 1.35, unidade: 'KG', valorUnitario: 6.90, valorTotal: 9.32 },
        { nome: 'TOMATE ITALIANO KG', codigo: '0000000001089', quantidade: 0.92, unidade: 'KG', valorUnitario: 8.99, valorTotal: 8.27 },
        { nome: 'DETERSIVO LIQUIDO 500ML', codigo: '7891000400407', quantidade: 2, unidade: 'UN', valorUnitario: 3.20, valorTotal: 6.40 },
      ],
    };
    saveToHistory(demoReceipt);
    renderReceipt(demoReceipt);
    showStatus('Cupom de exemplo carregado!', 'success');
    switchTab('products');
  });

  // CAPTCHA / Manual Paste Fallback
  function showCaptchaFallback(url = '') {
    els.captchaFallback.classList.remove('hidden');
    if (url && /^https?:\/\//i.test(url)) {
      els.btnOpenSefaz.href = url;
      els.btnOpenSefaz.classList.remove('hidden');
    } else {
      els.btnOpenSefaz.classList.add('hidden');
    }
    els.captchaFallback.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  els.btnTogglePaste.addEventListener('click', () => {
    const isHidden = els.captchaFallback.classList.contains('hidden');
    if (isHidden) {
      showCaptchaFallback(lastScannedUrl);
    } else {
      els.captchaFallback.classList.add('hidden');
    }
  });

  els.btnParsePasted.addEventListener('click', () => {
    const raw = els.pasteReceiptInput.value.trim();
    if (!raw) {
      showStatus('Cole o texto copiado da página da SEFAZ antes de extrair.', 'error');
      return;
    }

    const receipt = parsePastedReceiptText(raw, lastScannedUrl);
    if (!receipt.itens.length) {
      showStatus(
        'Não foi possível identificar produtos no texto colado. Certifique-se de copiar a página inteira da nota.',
        'error'
      );
      return;
    }

    saveToHistory(receipt);
    renderReceipt(receipt);
    els.pasteReceiptInput.value = '';
    els.captchaFallback.classList.add('hidden');
    showStatus(`Concluído! ${receipt.itens.length} produto(s) extraído(s) do texto.`, 'success');
    switchTab('products');
  });

  function parseBrNumStr(str) {
    const cleaned = String(str || '').replace(/[^\d,.\-]/g, '');
    if (!cleaned) return 0;
    if (cleaned.includes(',')) {
      return parseFloat(cleaned.replace(/\./g, '').replace(',', '.')) || 0;
    }
    return parseFloat(cleaned) || 0;
  }

  function parsePastedReceiptText(rawText, sourceUrl = '') {
    const lines = rawText
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+/g, ' ').trim())
      .filter(Boolean);

    const itens = [];

    // Strategy 1: Standard NFC-e copied text ("Qtde.: X UN: Y Vl. Unit.: Z")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const qtdMatch = line.match(/Qtde\.?\s*:?\s*([\d.,]+)/i);
      const vlUnitMatch = line.match(/Vl\.?\s*Unit\.?\s*:?\s*([\d.,]+)/i);

      if (qtdMatch && (vlUnitMatch || /UN\s*:/i.test(line))) {
        let nameLine = i > 0 ? lines[i - 1] : '';
        if (!nameLine || /^(Qtde|Vl\.|Valor|Código)/i.test(nameLine)) continue;

        const codMatch = nameLine.match(/\(?\s*C[oó]digo\s*:?\s*(\d+)\s*\)?/i);
        const codigo = codMatch ? codMatch[1] : '';
        const nome = nameLine.replace(/\(?\s*C[oó]digo\s*:?\s*\d+\s*\)?/i, '').trim();
        if (!nome) continue;

        const quantidade = parseBrNumStr(qtdMatch[1]) || 1;
        const unMatch = line.match(/UN\s*:?\s*([A-Za-z0-9]{1,6})/i);
        const unidade = unMatch ? unMatch[1].toUpperCase() : 'UN';
        let valorUnitario = vlUnitMatch ? parseBrNumStr(vlUnitMatch[1]) : 0;

        // Total may be on the same line or on the next 1-2 lines (e.g. after "Vl. Total")
        let valorTotal = 0;
        const sameLineTotal = line.match(/Vl\.?\s*Total\s*:?\s*([\d.,]+)/i);
        if (sameLineTotal) {
          valorTotal = parseBrNumStr(sameLineTotal[1]);
        } else {
          for (let j = i + 1; j <= Math.min(i + 2, lines.length - 1); j++) {
            if (/^Vl\.?\s*Total$/i.test(lines[j])) continue;
            const m = lines[j].match(/^(?:R\$\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})$/);
            if (m) {
              valorTotal = parseBrNumStr(m[1]);
              break;
            }
          }
        }

        if (valorTotal <= 0 && valorUnitario > 0) {
          valorTotal = Math.round(valorUnitario * quantidade * 100) / 100;
        }
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
    }

    // Strategy 2: SAT-SP / tabular lines ("001 789... PRODUTO 1,000 UN 12,50 12,50")
    if (!itens.length) {
      const satRegex = /^(?:\d{1,4}\s+)?(?:\d{6,14}\s+)?(.+?)\s+(\d+(?:,\d+)?)\s+([A-Za-z]{1,5})\s+(?:[xX]\s+)?(\d{1,3}(?:\.\d{3})*,\d{2})\s+(?:=\s+)?(\d{1,3}(?:\.\d{3})*,\d{2})$/;
      for (const line of lines) {
        if (/^(item|c[oó]digo|descri[cç][aã]o|qtd|total|troco|valor)/i.test(line)) continue;
        const m = line.match(satRegex);
        if (m) {
          const nome = m[1].trim();
          if (nome.length < 2) continue;
          const quantidade = parseBrNumStr(m[2]) || 1;
          const unidade = m[3].toUpperCase();
          const valorUnitario = parseBrNumStr(m[4]);
          const valorTotal = parseBrNumStr(m[5]);
          itens.push({ nome, codigo: '', quantidade, unidade, valorUnitario, valorTotal });
        }
      }
    }

    const cnpjMatch = rawText.match(/CNPJ\s*:?\s*([\d.\-\/]{14,18})/i);
    const dataMatch = rawText.match(/(\d{2}\/\d{2}\/\d{4}(?:\s+\d{2}:\d{2}(?::\d{2})?)?)/);
    const qtdTotalMatch = rawText.match(/Qtd\.?\s*total\s*(?:de\s*)?itens\s*:?\s*(\d+)/i);
    const totalMatch =
      rawText.match(/Valor\s+a\s+pagar\s*R?\$?\s*:?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i) ||
      rawText.match(/Valor\s+total\s*R?\$?\s*:?\s*(\d{1,3}(?:\.\d{3})*,\d{2})/i);

    const somaItens = itens.reduce((acc, item) => acc + item.valorTotal, 0);
    const valorTotal = totalMatch ? parseBrNumStr(totalMatch[1]) : somaItens;

    let estabelecimento = 'Supermercado / Estabelecimento';
    for (const line of lines.slice(0, 8)) {
      if (
        line.length >= 4 &&
        !/^(DOCUMENTO|DANFE|NFC-?e|CNPJ|Chave|Consulta|https?:)/i.test(line) &&
        !/^\d+$/.test(line)
      ) {
        estabelecimento = line;
        break;
      }
    }

    return {
      estabelecimento,
      cnpj: cnpjMatch ? cnpjMatch[1].trim() : '',
      data: dataMatch ? dataMatch[1].trim() : '',
      valorTotal: Math.round(valorTotal * 100) / 100,
      somaItens: Math.round(somaItens * 100) / 100,
      qtdItensInformada: qtdTotalMatch ? parseInt(qtdTotalMatch[1], 10) : null,
      url: sourceUrl,
      itens,
    };
  }

  // Helpers
  function formatBrl(value) {
    return Number(value || 0).toLocaleString('pt-BR', {
      style: 'currency',
      currency: 'BRL',
    });
  }

  function formatQty(qty) {
    const n = Number(qty || 1);
    return Number.isInteger(n) ? String(n) : n.toFixed(3).replace('.', ',');
  }

  // Init
  renderHistory();
})();
