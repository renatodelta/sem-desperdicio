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
      html5QrCode = new Html5Qrcode('qr-reader', {
        experimentalFeatures: { useBarCodeDetectorIfSupported: true },
        verbose: false,
      });
    }

    const scannerConfig = {
      fps: 20,
      qrbox: (viewfinderWidth, viewfinderHeight) => {
        const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
        const size = Math.max(180, Math.floor(minEdge * 0.72));
        return { width: size, height: size };
      },
      aspectRatio: 1.0,
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
        setStep(els.stepSefaz, 'error', 'Falha ao consultar a SEFAZ.');
        showStatus(result.error || 'Falha ao ler os produtos deste cupom.', 'error');
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
      showStatus('Erro de conexão com o servidor local (PHP).', 'error');
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
