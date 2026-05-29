/* ============================================================
   editor.js — Lógica do editor (carcaça).
   Carrega boletim.html via fetch, injeta no #document-host,
   gerencia edição/salvamento/impressão/download.

   Modos de persistência (detectados automaticamente):
   - SERVER  → POST /api/cache e /api/save (server.py local ou Netlify Functions)
   - BROWSER → localStorage (fallback ou Netlify estático sem functions)

   Pra Netlify estático: tudo continua funcionando, só "Salvar no Original"
   mostra mensagem dizendo que requer servidor/functions.
   ============================================================ */
(function () {
  'use strict';

  const LOCAL_KEY = 'boletim-editor-content-v2';
  const DOCUMENT_PATH = 'boletim.html';

  const HOST    = document.getElementById('document-host');
  const status  = document.getElementById('status');
  const btnEdit = document.getElementById('btn-edit');
  const btnPrint = document.getElementById('btn-print');
  const btnSave = document.getElementById('btn-save');
  const btnUpload = document.getElementById('btn-upload');
  const btnReset = document.getElementById('btn-reset');
  const fileInput = document.getElementById('file-input');
  // Dropdown de download
  const dlDropdown = document.getElementById('dl-dropdown');
  const btnDlToggle = document.getElementById('btn-download-toggle');
  const dlHtml = document.getElementById('dl-html');
  const dlPdf  = document.getElementById('dl-pdf');
  // Widget de espaçamento de estrofes
  const spacingMinus = document.getElementById('spacing-minus');
  const spacingPlus  = document.getElementById('spacing-plus');
  const spacingValue = document.getElementById('spacing-value');
  // Popup de formatação
  const formatPopup = document.getElementById('format-popup');
  // Override manual de número de estrofe
  const verseNumInput = document.getElementById('verse-number-input');
  const verseNumClear = document.getElementById('verse-number-clear');
  let currentVerseLi = null;
  // TEMA — descomenta pra reativar (1/3)
  // const btnTheme  = document.getElementById('btn-theme');
  // const themeIcon = document.getElementById('theme-icon');
  const btnTheme  = null;
  const themeIcon = null;
  const THEME_KEY = 'boletim-editor-theme';

  // Configuração do espaçamento de .lyric-block (em mm)
  const LYRIC_GAP_DEFAULT = 3.5;
  const LYRIC_GAP_MIN = 1.0;
  const LYRIC_GAP_MAX = 10.0;
  const LYRIC_GAP_STEP = 0.5;
  let currentLyricBlock = null;

  let editMode  = false;
  let saveTimer = null;
  let serverOn  = false;
  let documentDom = null; // DOM original do boletim.html (template + initial content)

  // ---------- helpers ----------
  function setStatus(msg) { if (status) status.textContent = msg || ''; }
  function timestamp() {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  }
  function getCurrentBook() { return HOST.querySelector('.book'); }

  // ---------- detecção de servidor ----------
  async function checkServer() {
    try {
      const res = await fetch('/api/health', { cache: 'no-store' });
      serverOn = res.ok;
    } catch (e) {
      serverOn = false;
    }
    return serverOn;
  }

  // ---------- carregamento do documento ----------
  // Baixa boletim.html, parseia, e injeta o .book no #document-host.
  // Guarda o DOM original em `documentDom` pra reconstruir o HTML completo no salvamento.
  async function loadDocument() {
    const res = await fetch(DOCUMENT_PATH, { cache: 'no-store' });
    if (!res.ok) throw new Error('Não foi possível carregar ' + DOCUMENT_PATH);
    const text = await res.text();
    documentDom = new DOMParser().parseFromString(text, 'text/html');
    const originalBook = documentDom.querySelector('.book');
    if (!originalBook) throw new Error('boletim.html não contém .book');
    HOST.innerHTML = '';
    HOST.appendChild(originalBook.cloneNode(true));
    lockNonEditableRegions();
  }

  // Substitui o .book atual no HOST por um novo (vindo do cache).
  function setBookFromHtml(html) {
    try {
      const parsed = new DOMParser().parseFromString(html, 'text/html');
      const bk = parsed.querySelector('.book');
      if (!bk) return false;
      HOST.innerHTML = '';
      HOST.appendChild(bk.cloneNode(true));
      lockNonEditableRegions();
      return true;
    } catch (e) {
      return false;
    }
  }

  // Marca rodapés (paginação) como não-editáveis, mesmo que o HTML carregado
  // não tenha esse atributo. Garantia para arquivos importados via upload.
  function lockNonEditableRegions() {
    HOST.querySelectorAll('.panel-footer').forEach((el) => {
      el.setAttribute('contenteditable', 'false');
    });
    ensureFoldTicks();
  }

  // Garante que as marcas de dobra existem no segundo sheet (lado interno).
  function ensureFoldTicks() {
    const sheets = HOST.querySelectorAll('.sheet');
    if (sheets.length < 2) return;
    const inner = sheets[1];
    if (inner.querySelector('.fold-tick')) return; // já tem
    const positions = ['tl', 'bl', 'tr', 'br'];
    positions.forEach((pos) => {
      const span = document.createElement('span');
      span.className = 'fold-tick ' + pos;
      span.setAttribute('contenteditable', 'false');
      inner.insertBefore(span, inner.firstChild);
    });
  }

  // Reconstrói o HTML completo do boletim (DOCTYPE + html + head + body + .book editado).
  function buildFullDocumentHtml() {
    if (!documentDom) return null;
    const docClone = documentDom.cloneNode(true);
    const placeholder = docClone.querySelector('.book');
    const currentBook = getCurrentBook().cloneNode(true);
    currentBook.setAttribute('contenteditable', 'false');
    if (placeholder) {
      placeholder.parentNode.replaceChild(currentBook, placeholder);
    } else if (docClone.body) {
      docClone.body.appendChild(currentBook);
    }
    return '<!DOCTYPE html>\n' + docClone.documentElement.outerHTML;
  }

  // ---------- cache (servidor ou localStorage) ----------
  async function tryLoadCache() {
    if (serverOn) {
      try {
        const res = await fetch('/api/cache', { cache: 'no-store' });
        const data = await res.json();
        if (data.exists && data.html) {
          if (setBookFromHtml(data.html)) {
            const t = new Date(data.mtime * 1000).toLocaleString('pt-BR');
            setStatus('Cache restaurado · ' + t);
            return true;
          }
        }
      } catch (e) { console.warn('Falha ao ler cache do servidor:', e); }
    }
    try {
      const saved = localStorage.getItem(LOCAL_KEY);
      if (saved && setBookFromHtml(saved)) {
        setStatus('Restaurado do browser');
        return true;
      }
    } catch (e) {}
    return false;
  }

  async function saveCache() {
    const html = buildFullDocumentHtml();
    if (!html) return;
    let okLocal = false, okFile = false;
    try {
      localStorage.setItem(LOCAL_KEY, html);
      okLocal = true;
    } catch (e) {}
    if (serverOn) {
      try {
        const res = await fetch('/api/cache', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ html })
        });
        okFile = res.ok;
      } catch (e) { console.warn('Falha ao salvar no servidor:', e); }
    }
    if (okFile) setStatus('Cache (.cache/) + browser · ' + timestamp());
    else if (okLocal) setStatus('Salvo no browser · ' + timestamp());
    else setStatus('Erro ao salvar');
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveCache, 500);
  }

  // ---------- salvar no original ----------
  async function saveToOriginal() {
    if (!serverOn) {
      alert('Servidor local não está rodando. Para salvar no arquivo original:\n\n' +
            '  cd "Liturgy Guide Editor"\n' +
            '  python3 server.py\n\n' +
            'Depois acesse http://localhost:8765/editor.html');
      return;
    }
    if (!confirm('Sobrescrever boletim.html com a versão atual?\nO arquivo de cache será apagado.')) return;
    if (editMode) setEditMode(false);
    const html = buildFullDocumentHtml();
    try {
      const res = await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html })
      });
      if (res.ok) {
        try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
        setStatus('Salvo em boletim.html · ' + timestamp());
        // Atualiza documentDom pra refletir o novo "estado original"
        documentDom = new DOMParser().parseFromString(html, 'text/html');
      } else {
        setStatus('Erro ao salvar no original');
      }
    } catch (e) {
      setStatus('Erro: ' + e.message);
    }
  }

  // ---------- modo de edição ----------
  function setEditMode(on) {
    editMode = on;
    document.body.classList.toggle('edit-mode', on);
    const bk = getCurrentBook();
    if (bk) bk.contentEditable = on ? 'true' : 'false';
    btnEdit.textContent = on ? 'Sair da edição' : 'Editar';
    btnEdit.classList.toggle('secondary', on);
    if (on) setStatus('Selecione texto para ver as opções de formatação');
    else {
      document.body.classList.remove('has-selection');
      document.body.classList.remove('in-block');
      currentLyricBlock = null;
      saveCache();
    }
  }
  function toggleEdit() { setEditMode(!editMode); }

  // ---------- detecção de seleção ativa ----------
  // Mostra o popup de formatação só quando há seleção não-vazia no documento,
  // posicionando-o logo acima do texto selecionado.
  function updateSelectionState() {
    if (!editMode) {
      document.body.classList.remove('has-selection');
      return;
    }
    // Se o foco está dentro do popup (ex.: usuário digitando no input de número),
    // não altera o estado — popup continua visível
    if (formatPopup.contains(document.activeElement)) return;

    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
      document.body.classList.remove('has-selection');
      return;
    }
    const range = sel.getRangeAt(0);
    const node = range.commonAncestorContainer;
    if (HOST.contains(node)) {
      document.body.classList.add('has-selection');
      positionFormatPopup(range);
    } else {
      document.body.classList.remove('has-selection');
    }
  }

  // Posiciona o popup logo acima da seleção (ou abaixo se faltar espaço).
  function positionFormatPopup(range) {
    const rect = range.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    // Mede o popup. Se ainda não tem tamanho, força um reflow.
    if (formatPopup.offsetWidth === 0) {
      formatPopup.style.opacity = '0';
      formatPopup.style.display = 'inline-flex';
    }
    const popupWidth  = formatPopup.offsetWidth  || 220;
    const popupHeight = formatPopup.offsetHeight || 40;
    const margin = 8;
    let top  = rect.top - popupHeight - margin;
    let left = rect.left + (rect.width / 2) - (popupWidth / 2);
    // Se não couber acima, posiciona abaixo
    if (top < 8) top = rect.bottom + margin;
    // Mantém dentro da viewport horizontalmente
    const minLeft = 8;
    const maxLeft = window.innerWidth - popupWidth - 8;
    left = Math.max(minLeft, Math.min(maxLeft, left));
    formatPopup.style.top  = top  + 'px';
    formatPopup.style.left = left + 'px';
  }

  // ---------- detecção de bloco editável atual (parágrafo, título, etc.) ----------
  // Mostra o widget de espaçamento quando o cursor está em qualquer bloco do documento.
  // Tratamento especial: se o bloco é um <p> dentro de .lyric-block, ajusta o
  // espaçamento UNIFORMEMENTE em todas as estrofes do bloco (via --lyric-gap).
  const BLOCK_SELECTOR = 'p, h1, h2, h3, h4, h5, h6, blockquote, li';
  const PX_PER_MM = 96 / 25.4;

  function getCurrentBlock() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || !node.closest) return null;
    const block = node.closest(BLOCK_SELECTOR);
    return (block && HOST.contains(block)) ? block : null;
  }

  // Retorna o "contexto de espaçamento": ou um .lyric-block (uniforme), ou o próprio bloco.
  function getSpacingContext(block) {
    if (!block) return null;
    // Se for um <p> dentro de .lyric-block, o contexto é o container (.lyric-block)
    if (block.tagName === 'P') {
      const lb = block.closest('.lyric-block');
      if (lb && HOST.contains(lb)) return { kind: 'lyric', element: lb };
    }
    return { kind: 'element', element: block };
  }

  function formatMm(v) {
    return (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + 'mm';
  }
  function updateSpacingDisplay(mm) {
    spacingValue.textContent = formatMm(mm);
  }

  function getSpacingValue(ctx) {
    if (ctx.kind === 'lyric') {
      const inline = ctx.element.style.getPropertyValue('--lyric-gap');
      if (inline) return parseFloat(inline) || LYRIC_GAP_DEFAULT;
      return LYRIC_GAP_DEFAULT;
    }
    // Elemento individual: lê inline primeiro, depois computed
    const inline = ctx.element.style.marginBottom;
    if (inline) {
      if (inline.endsWith('mm')) return parseFloat(inline);
      if (inline.endsWith('px')) return parseFloat(inline) / PX_PER_MM;
      return parseFloat(inline) || 0;
    }
    const mbPx = parseFloat(getComputedStyle(ctx.element).marginBottom) || 0;
    return mbPx / PX_PER_MM;
  }

  function setSpacingValue(ctx, mm) {
    mm = Math.max(LYRIC_GAP_MIN, Math.min(LYRIC_GAP_MAX, mm));
    mm = Math.round(mm * 10) / 10;
    if (ctx.kind === 'lyric') {
      ctx.element.style.setProperty('--lyric-gap', mm + 'mm');
    } else {
      ctx.element.style.marginBottom = mm + 'mm';
    }
    updateSpacingDisplay(mm);
    scheduleSave();
  }

  function updateBlockState() {
    if (!editMode) {
      document.body.classList.remove('in-block');
      currentLyricBlock = null;
      return;
    }
    const block = getCurrentBlock();
    const ctx = getSpacingContext(block);
    if (ctx) {
      currentLyricBlock = ctx; // reaproveita a variável global pra guardar o contexto
      document.body.classList.add('in-block');
      updateSpacingDisplay(getSpacingValue(ctx));
    } else {
      currentLyricBlock = null;
      document.body.classList.remove('in-block');
    }
  }

  // ---------- detecção de cursor em <li> de ol.verses (pra override de número) ----------
  function getVerseLi() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || !node.closest) return null;
    const li = node.closest('li');
    if (!li || !HOST.contains(li)) return null;
    const ol = li.parentElement;
    if (!ol || !ol.classList || !ol.classList.contains('verses')) return null;
    if (li.classList.contains('refrain')) return null; // refrão não tem número
    return li;
  }

  function updateVerseLiState() {
    if (!editMode) {
      document.body.classList.remove('in-verse-li');
      currentVerseLi = null;
      return;
    }
    // Não atualiza enquanto o input está sendo editado (preserva o estado)
    if (document.activeElement === verseNumInput) return;

    const li = getVerseLi();
    if (li) {
      currentVerseLi = li;
      document.body.classList.add('in-verse-li');
      verseNumInput.value = li.getAttribute('data-num') || '';
    } else {
      currentVerseLi = null;
      document.body.classList.remove('in-verse-li');
    }
  }

  // ---------- imprimir ----------
  function doPrint() {
    const wasEditing = editMode;
    if (wasEditing) setEditMode(false);
    setTimeout(() => {
      window.print();
      if (wasEditing) setEditMode(true);
    }, 80);
  }

  // ---------- download ----------
  function downloadHtml() {
    if (editMode) setEditMode(false);
    const html = buildFullDocumentHtml();
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = 'boletim-' + stamp + '.html';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    setStatus('HTML baixado');
  }

  // ---------- download PDF (via print dialog) ----------
  // Usa o diálogo de impressão do navegador. O usuário escolhe "Salvar como PDF"
  // como destino. Vantagem: qualidade nativa, fontes perfeitas, texto selecionável,
  // sem dependências.
  function downloadPdf() {
    const wasEditing = editMode;
    if (wasEditing) setEditMode(false);
    setStatus('Na janela de impressão, escolha "Salvar como PDF" como destino');
    setTimeout(() => {
      window.print();
      if (wasEditing) setEditMode(true);
    }, 100);
  }

  // ---------- upload HTML ----------
  // Lê um arquivo .html, extrai o .book e o head/template, substitui o conteúdo atual.
  async function uploadHtml(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = new DOMParser().parseFromString(text, 'text/html');
      const newBook = parsed.querySelector('.book');
      if (!newBook) {
        alert('Não consegui encontrar um <div class="book"> no arquivo.\n\nVerifique se é um boletim válido.');
        return;
      }
      if (editMode) setEditMode(false);
      // Confirmação: se já há conteúdo, avisar que vai sobrescrever
      if (!confirm('Substituir o conteúdo atual pelo do arquivo "' + file.name + '"?')) return;
      HOST.innerHTML = '';
      HOST.appendChild(newBook.cloneNode(true));
      lockNonEditableRegions();
      // Atualiza o template (head) também, pra que próximos saves preservem
      documentDom = parsed;
      // Aciona auto-save imediatamente
      await saveCache();
      setStatus('Carregado: ' + file.name);
    } catch (e) {
      setStatus('Erro ao carregar: ' + e.message);
      console.error(e);
    }
  }

  // ---------- reset ----------
  async function reset() {
    if (!confirm('Apagar todas as edições e restaurar o conteúdo original?')) return;
    try { localStorage.removeItem(LOCAL_KEY); } catch (e) {}
    if (serverOn) {
      try { await fetch('/api/clear-cache', { method: 'POST' }); } catch (e) {}
    }
    await loadDocument();
    setStatus('Restaurado ao original');
  }

  // ---------- formatação inline (negrito, itálico, listas) ----------
  function setupFormatButtons() {
    const alignDropdown = document.getElementById('align-dropdown');

    document.querySelectorAll('.toolbar .fmt, .format-popup .fmt').forEach((btn) => {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault(); // preserva a seleção
        if (!editMode) return;
        // Botão dedicado pra refrão tem ID próprio (não usa execCommand)
        if (btn.id === 'btn-refrain') {
          toggleRefrain();
          return;
        }
        // Toggle do dropdown de alinhamento — só abre/fecha, não executa comando
        if (btn.id === 'align-toggle') {
          e.stopPropagation();
          alignDropdown.classList.toggle('open');
          return;
        }
        const cmd = btn.dataset.cmd;
        if (cmd) {
          document.execCommand(cmd, false, null);
          scheduleSave();
          // Se o botão estava dentro do dropdown de alinhamento, fecha depois de aplicar
          if (alignDropdown && alignDropdown.contains(btn)) {
            alignDropdown.classList.remove('open');
          }
        }
      });
    });

    // Fecha o dropdown de alinhamento quando clica fora dele
    document.addEventListener('click', (e) => {
      if (alignDropdown && !alignDropdown.contains(e.target)) {
        alignDropdown.classList.remove('open');
      }
    });
  }

  // Alterna a estrofe atual entre numerada (1., 2., …) e refrão (R.)
  function toggleRefrain() {
    const sel = window.getSelection();
    if (!sel.rangeCount) {
      setStatus('Posicione o cursor numa estrofe');
      return;
    }
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    // Procura o <li> dentro de uma <ol class="verses"> mais próximo
    let li = node.closest && node.closest('ol.verses > li');
    if (!li) {
      setStatus('Posicione o cursor dentro de uma estrofe');
      return;
    }
    li.classList.toggle('refrain');
    // Refrão não usa atributo value (não numerado)
    if (li.classList.contains('refrain')) li.removeAttribute('value');
    scheduleSave();
  }

  // ---------- atalhos de teclado ----------
  function setupShortcuts() {
    document.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        toggleEdit();
      }
    });
  }

  // ---------- tema (claro / escuro) ----------
  function setTheme(theme) {
    document.body.classList.remove('dark', 'light');
    document.body.classList.add(theme);
    if (themeIcon) themeIcon.textContent = (theme === 'dark') ? 'light_mode' : 'dark_mode';
    if (btnTheme)  btnTheme.title = (theme === 'dark') ? 'Mudar para tema claro' : 'Mudar para tema escuro';
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  }
  function toggleTheme() {
    setTheme(document.body.classList.contains('dark') ? 'light' : 'dark');
  }
  function initTheme() {
    let theme = null;
    try { theme = localStorage.getItem(THEME_KEY); } catch (e) {}
    if (theme !== 'dark' && theme !== 'light') {
      // Default: respeita a preferência do sistema
      theme = (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light';
    }
    setTheme(theme);
  }

  // ---------- inicialização ----------
  async function init() {
    // TEMA — descomenta pra reativar (2/3)
    // initTheme();

    btnEdit.addEventListener('click', toggleEdit);
    btnPrint.addEventListener('click', doPrint);
    btnSave.addEventListener('click', saveToOriginal);
    btnUpload.addEventListener('click', () => fileInput.click());
    // TEMA — descomenta pra reativar (3/3)
    // btnTheme.addEventListener('click', toggleTheme);
    fileInput.addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      uploadHtml(file);
      e.target.value = ''; // permite recarregar o mesmo arquivo
    });
    btnReset.addEventListener('click', reset);

    // Dropdown de download
    btnDlToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      dlDropdown.classList.toggle('open');
    });
    dlHtml.addEventListener('click', () => {
      dlDropdown.classList.remove('open');
      downloadHtml();
    });
    dlPdf.addEventListener('click', () => {
      dlDropdown.classList.remove('open');
      downloadPdf();
    });
    document.addEventListener('click', (e) => {
      if (!dlDropdown.contains(e.target)) dlDropdown.classList.remove('open');
    });
    setupFormatButtons();
    setupShortcuts();

    HOST.addEventListener('input', () => { if (editMode) scheduleSave(); });

    // Atualiza visibilidade do grupo de formatação, espaçamento e número de estrofe
    document.addEventListener('selectionchange', () => {
      updateSelectionState();
      updateBlockState();
      updateVerseLiState();
    });

    // Override de número de estrofe
    verseNumInput.addEventListener('input', () => {
      if (!currentVerseLi) return;
      const v = verseNumInput.value.trim();
      if (v) {
        currentVerseLi.setAttribute('data-num', v);
      } else {
        currentVerseLi.removeAttribute('data-num');
      }
      scheduleSave();
    });
    verseNumClear.addEventListener('mousedown', (e) => {
      e.preventDefault(); // preserva foco/seleção
      if (!currentVerseLi) return;
      currentVerseLi.removeAttribute('data-num');
      verseNumInput.value = '';
      scheduleSave();
    });

    // Reposiciona o popup ao rolar/redimensionar (se há seleção ativa)
    function repositionPopupIfNeeded() {
      if (!document.body.classList.contains('has-selection')) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      positionFormatPopup(sel.getRangeAt(0));
    }
    window.addEventListener('scroll', repositionPopupIfNeeded, true);
    window.addEventListener('resize', repositionPopupIfNeeded);

    // Botões de espaçamento de estrofes
    spacingMinus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!currentLyricBlock) return;
      setSpacingValue(currentLyricBlock, getSpacingValue(currentLyricBlock) - LYRIC_GAP_STEP);
    });
    spacingPlus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!currentLyricBlock) return;
      setSpacingValue(currentLyricBlock, getSpacingValue(currentLyricBlock) + LYRIC_GAP_STEP);
    });

    try {
      await loadDocument();
    } catch (e) {
      setStatus('Erro ao carregar documento: ' + e.message);
      console.error(e);
      return;
    }
    await checkServer();
    const restored = await tryLoadCache();
    if (!restored) {
      setStatus(serverOn ? 'Servidor conectado' : 'Sem servidor — modo browser');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
