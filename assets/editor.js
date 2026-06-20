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
  const btnMove = document.getElementById('btn-move');
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
  // Widget de kerning (letter-spacing)
  const trackingMinus = document.getElementById('tracking-minus');
  const trackingPlus  = document.getElementById('tracking-plus');
  const trackingValue = document.getElementById('tracking-value');
  const TRACKING_MIN = -2.0;   // px
  const TRACKING_MAX = 10.0;   // px
  const TRACKING_STEP = 0.1;   // px (passo fino pra ajustes tipográficos sutis)
  // Widget de entrelinha (line-height)
  const lineHeightMinus = document.getElementById('line-height-minus');
  const lineHeightPlus  = document.getElementById('line-height-plus');
  const lineHeightValue = document.getElementById('line-height-value');
  const LH_MIN = 0.8;          // ratio (unitless)
  const LH_MAX = 2.5;
  const LH_STEP = 0.1;
  const LH_DEFAULT_FALLBACK = 1.35;
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

  // Zoom do documento (afeta só o #document-host, não a chrome do editor)
  const btnZoomIn    = document.getElementById('zoom-in');
  const btnZoomOut   = document.getElementById('zoom-out');
  const zoomValueBtn = document.getElementById('zoom-value');
  const ZOOM_KEY = 'liturgy-editor-zoom';
  const ZOOM_MIN = 0.4;
  const ZOOM_MAX = 2.5;
  const ZOOM_STEP = 0.1;
  let currentZoom = 1.0;

  // Configuração do espaçamento (em mm).
  // MIN negativo permite "puxar" o próximo elemento pra cima (útil pra compactar layout).
  const LYRIC_GAP_DEFAULT = 3.5;
  const LYRIC_GAP_MIN = -5.0;
  const LYRIC_GAP_MAX = 15.0;
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
    // Edit e drag são mutuamente exclusivos
    if (on && typeof dragMode !== 'undefined' && dragMode) setDragMode(false);
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

  // ---------- modo MOVER (drag-and-drop) ----------
  let dragMode = false;
  let draggedElement = null;
  let dropTarget = null;
  let dropBefore = true;

  function setDragMode(on) {
    dragMode = on;
    document.body.classList.toggle('drag-mode', on);
    btnMove.classList.toggle('active', on);

    const book = getCurrentBook();
    if (!book) return;

    if (on) {
      // Sai do modo edição se estiver ativo (são mutuamente exclusivos)
      if (editMode) setEditMode(false);
      // Desabilita contenteditable pra DnD funcionar limpo
      book.dataset.prevEditable = book.contentEditable;
      book.contentEditable = 'false';
      // Marca todos os filhos diretos de .panel-body como draggable
      HOST.querySelectorAll('.panel-body > *').forEach((el) => {
        el.setAttribute('draggable', 'true');
      });
      setStatus('Modo mover ativo — arraste blocos entre painéis. Esc pra sair.');
    } else {
      // Restaura contenteditable
      book.contentEditable = book.dataset.prevEditable || 'false';
      delete book.dataset.prevEditable;
      // Remove draggable
      HOST.querySelectorAll('[draggable="true"]').forEach((el) => {
        el.removeAttribute('draggable');
      });
      clearDropIndicators();
      saveCache();
    }
  }
  function toggleDragMode() { setDragMode(!dragMode); }

  function clearDropIndicators() {
    document.querySelectorAll('.drop-target-before, .drop-target-after, .drop-target-empty')
      .forEach((el) => {
        el.classList.remove('drop-target-before', 'drop-target-after', 'drop-target-empty');
      });
  }

  function findDropPosition(panelBody, clientY) {
    const children = Array.from(panelBody.children).filter((c) => c !== draggedElement);
    if (children.length === 0) {
      return { target: panelBody, before: true, isEmpty: true };
    }
    let closest = null;
    let closestDist = Infinity;
    let before = true;
    for (const child of children) {
      const rect = child.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const dist = Math.abs(clientY - mid);
      if (dist < closestDist) {
        closestDist = dist;
        closest = child;
        before = clientY < mid;
      }
    }
    return { target: closest, before, isEmpty: false };
  }

  function setupDragHandlers() {
    HOST.addEventListener('dragstart', (e) => {
      if (!dragMode) return;
      const target = e.target.closest('.panel-body > *');
      if (!target) return;
      draggedElement = target;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', ''); // necessário no Firefox
      // setTimeout pra não interferir com a captura da imagem de drag
      setTimeout(() => target.classList.add('dragging'), 0);
    });

    HOST.addEventListener('dragover', (e) => {
      if (!dragMode || !draggedElement) return;
      const panelBody = e.target.closest('.panel-body');
      if (!panelBody) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const pos = findDropPosition(panelBody, e.clientY);
      clearDropIndicators();
      if (pos.isEmpty) {
        panelBody.classList.add('drop-target-empty');
      } else if (pos.target) {
        pos.target.classList.add(pos.before ? 'drop-target-before' : 'drop-target-after');
      }
      dropTarget = pos.target;
      dropBefore = pos.before;
    });

    HOST.addEventListener('drop', (e) => {
      if (!dragMode || !draggedElement) return;
      e.preventDefault();
      const panelBody = e.target.closest('.panel-body');
      if (!panelBody) return;

      const pos = findDropPosition(panelBody, e.clientY);
      if (pos.isEmpty) {
        panelBody.appendChild(draggedElement);
      } else if (pos.target) {
        const ref = pos.before ? pos.target : pos.target.nextSibling;
        pos.target.parentNode.insertBefore(draggedElement, ref);
      }
      cleanupDrag();
      scheduleSave();
    });

    HOST.addEventListener('dragend', () => {
      cleanupDrag();
    });

    // Esc sai do modo mover
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && dragMode) {
        e.preventDefault();
        setDragMode(false);
      }
    });
  }

  function cleanupDrag() {
    if (draggedElement) draggedElement.classList.remove('dragging');
    clearDropIndicators();
    draggedElement = null;
    dropTarget = null;
  }

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

  // Divs estruturais que NÃO devem ser tratados como "bloco editável"
  const STRUCTURAL_DIV_CLASSES = [
    'book', 'sheet', 'panel', 'panel-body', 'panel-footer',
    'cover', 'cover-verse', 'cover-foot', 'logo'
  ];
  function isStructuralDiv(el) {
    if (!el || el.tagName !== 'DIV' || !el.classList) return false;
    for (const cls of STRUCTURAL_DIV_CLASSES) {
      if (el.classList.contains(cls)) return true;
    }
    return false;
  }

  function getCurrentBlock() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || !node.closest) return null;

    // Caso especial: se o cursor está dentro de uma .lyric-block, devolve
    // a própria .lyric-block como bloco — getSpacingContext vai tratar como
    // contexto uniforme (ajusta --lyric-gap em vez de margin-bottom de cada item)
    const lyricBlock = node.closest('.lyric-block');
    if (lyricBlock && HOST.contains(lyricBlock)) {
      return lyricBlock;
    }

    // 1ª tentativa: tags semânticas tradicionais
    let block = node.closest(BLOCK_SELECTOR);
    // Fallback: qualquer <div> não-estrutural ancestral (browsers criam divs
    // em contenteditable quando o usuário pressiona Enter)
    if (!block) {
      let current = node;
      while (current && current !== HOST) {
        if (current.tagName === 'DIV' && !isStructuralDiv(current)) {
          block = current;
          break;
        }
        current = current.parentElement;
      }
    }
    return (block && HOST.contains(block)) ? block : null;
  }

  // Retorna o "contexto de espaçamento": ou um .lyric-block (uniforme), ou o próprio bloco.
  function getSpacingContext(block) {
    if (!block) return null;
    // Se o próprio bloco é uma .lyric-block, contexto é uniforme
    if (block.classList && block.classList.contains('lyric-block')) {
      return { kind: 'lyric', element: block };
    }
    // Se for um <p> ou <div> dentro de .lyric-block, idem (uniforme)
    if (block.tagName === 'P' || block.tagName === 'DIV') {
      const lb = block.closest('.lyric-block');
      if (lb && HOST.contains(lb) && lb !== block) {
        return { kind: 'lyric', element: lb };
      }
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
      updateTrackingDisplay(getTrackingValue(ctx));
      // Line-height usa contexto SEPARADO (per-bloco), pra não herdar pra toda a coluna
      const lineCtx = getLineHeightContext();
      if (lineCtx) updateLineHeightDisplay(getLineHeightValue(lineCtx));
    } else {
      currentLyricBlock = null;
      document.body.classList.remove('in-block');
    }
  }

  // ---------- kerning (letter-spacing) ----------
  function getTrackingValue(ctx) {
    const el = ctx.element;
    // Inline tem prioridade
    if (el.style.letterSpacing) {
      const v = el.style.letterSpacing;
      if (v.endsWith('px')) return parseFloat(v) || 0;
      if (v === 'normal') return 0;
      return parseFloat(v) || 0;
    }
    // Computed (vem em px na maioria dos casos)
    const comp = getComputedStyle(el).letterSpacing;
    if (!comp || comp === 'normal') return 0;
    return parseFloat(comp) || 0;
  }

  function setTrackingValue(ctx, px) {
    px = Math.max(TRACKING_MIN, Math.min(TRACKING_MAX, px));
    px = Math.round(px * 10) / 10;
    // Normaliza -0 → 0 (cosmetic)
    if (Object.is(px, -0)) px = 0;
    // Sempre define o inline (mesmo pra 0), pra não deixar o CSS-default reassumir
    // quando o usuário tenta passar do zero indo pra negativo
    ctx.element.style.letterSpacing = px + 'px';
    updateTrackingDisplay(px);
    scheduleSave();
  }

  function updateTrackingDisplay(px) {
    if (!trackingValue) return;
    px = Math.round(px * 10) / 10;
    const label = (px > 0 ? '+' : '') + (px === 0 ? '0' : px.toString().replace(/\.0$/, ''));
    trackingValue.textContent = label + 'px';
  }

  // ---------- entrelinha (line-height) ----------
  // Diferente de margin-bottom: line-height afeta o espaço ENTRE as linhas
  // dentro de um mesmo parágrafo (linhas separadas por <br> ou wrapping).
  //
  // IMPORTANTE: usa contexto PER-BLOCO (não usa .lyric-block como container
  // uniforme), pra evitar que line-height herde pra toda a coluna de letras.
  function getLineHeightContext() {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    let node = sel.getRangeAt(0).startContainer;
    if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
    if (!node || !node.closest) return null;
    // 1ª tentativa: bloco semântico mais próximo (NÃO sobe pra .lyric-block)
    let block = node.closest(BLOCK_SELECTOR);
    // Fallback: <div> não-estrutural — exclui também .lyric-block aqui
    if (!block) {
      let current = node;
      while (current && current !== HOST) {
        if (current.tagName === 'DIV' &&
            !isStructuralDiv(current) &&
            !current.classList.contains('lyric-block')) {
          block = current;
          break;
        }
        current = current.parentElement;
      }
    }
    if (!block || !HOST.contains(block)) return null;
    return { kind: 'element', element: block };
  }

  function getLineHeightValue(ctx) {
    const el = ctx.element;
    // Inline tem prioridade
    if (el.style.lineHeight) {
      const v = el.style.lineHeight;
      if (v === 'normal') return LH_DEFAULT_FALLBACK;
      if (v.endsWith('%')) return parseFloat(v) / 100;
      // Unitless (ex.: "1.5") ou com unidade — pega o número
      const num = parseFloat(v);
      if (!isNaN(num) && num > 0 && num < 5) return num;
      // Se tem unidade (px, em), tenta converter pra ratio
      const fs = parseFloat(getComputedStyle(el).fontSize) || 1;
      return num / fs;
    }
    // Computed line-height vem em px, converte pra ratio
    const comp = getComputedStyle(el).lineHeight;
    if (!comp || comp === 'normal') return LH_DEFAULT_FALLBACK;
    const lhPx = parseFloat(comp);
    const fsPx = parseFloat(getComputedStyle(el).fontSize) || 1;
    if (fsPx > 0 && !isNaN(lhPx)) {
      return Math.round((lhPx / fsPx) * 100) / 100;
    }
    return LH_DEFAULT_FALLBACK;
  }

  function setLineHeightValue(ctx, value) {
    value = Math.max(LH_MIN, Math.min(LH_MAX, value));
    value = Math.round(value * 10) / 10;
    // Aplica como unitless (recomendado em CSS pra inheritance previsível)
    ctx.element.style.lineHeight = String(value);
    updateLineHeightDisplay(value);
    scheduleSave();
  }

  function updateLineHeightDisplay(value) {
    if (!lineHeightValue) return;
    value = Math.round(value * 10) / 10;
    lineHeightValue.textContent = value.toFixed(1);
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
        // Botão all-caps (text-transform: uppercase) também é toggle dedicado
        if (btn.id === 'btn-allcaps') {
          toggleAllCaps();
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
          // Pós-processo: lista ordenada recém-criada ganha class="verses"
          // pra herdar o estilo de estrofe (Bitter italic, "1." no gutter).
          if (cmd === 'insertOrderedList') {
            applyVersesClassToCurrentList();
          }
          scheduleSave();
          // Se o botão estava dentro do dropdown de alinhamento, fecha depois de aplicar
          if (alignDropdown && alignDropdown.contains(btn)) {
            alignDropdown.classList.remove('open');
          }
        }
      });
    });

    // Helper: encontra o <ol> ancestral da seleção atual e adiciona class="verses"
    function applyVersesClassToCurrentList() {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      let node = sel.getRangeAt(0).startContainer;
      if (node.nodeType === Node.TEXT_NODE) node = node.parentNode;
      while (node && node !== HOST) {
        if (node.tagName === 'OL' && !node.classList.contains('verses')) {
          node.classList.add('verses');
          break;
        }
        node = node.parentElement;
      }
    }

    // Fecha o dropdown de alinhamento quando clica fora dele
    document.addEventListener('click', (e) => {
      if (alignDropdown && !alignDropdown.contains(e.target)) {
        alignDropdown.classList.remove('open');
      }
    });
  }

  // Alterna text-transform: uppercase.
  // Comportamento:
  //   • Se há TEXTO SELECIONADO → envolve só a seleção num <span style="text-transform:uppercase">
  //     (toggle: clicar de novo desfaz o span)
  //   • Se há apenas cursor (sem seleção) → aplica no bloco onde o cursor está,
  //     usando contexto per-bloco (não sobe pra .lyric-block)
  function toggleAllCaps() {
    const sel = window.getSelection();

    // Caso 1: SELEÇÃO ATIVA — wrap em span
    if (sel && sel.rangeCount > 0 && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      // Verifica se a seleção já está dentro de um span uppercase (toggle off)
      const enclosing = findEnclosingUppercaseSpan(range);
      if (enclosing) {
        unwrapElement(enclosing);
        scheduleSave();
        updateAllCapsState();
        return;
      }
      try {
        const span = document.createElement('span');
        span.style.textTransform = 'uppercase';
        range.surroundContents(span);
        scheduleSave();
        updateAllCapsState();
        return;
      } catch (e) {
        // surroundContents falha quando a seleção cruza fronteiras de elemento.
        // Cai pro modo per-bloco abaixo.
      }
    }

    // Caso 2: SEM SELEÇÃO — aplica no bloco inteiro
    const ctx = getLineHeightContext();
    if (!ctx) {
      setStatus('Posicione o cursor num bloco editável');
      return;
    }
    const el = ctx.element;
    const inline = el.style.textTransform;
    const computed = getComputedStyle(el).textTransform;

    if (inline === 'uppercase' || inline === 'none') {
      el.style.textTransform = '';
    } else if (computed === 'uppercase') {
      el.style.textTransform = 'none';
    } else {
      el.style.textTransform = 'uppercase';
    }
    updateAllCapsState();
    scheduleSave();
  }

  // Helpers pra manipular spans de uppercase em seleções
  function findEnclosingUppercaseSpan(range) {
    let el = range.commonAncestorContainer;
    if (el.nodeType === Node.TEXT_NODE) el = el.parentNode;
    while (el && el !== HOST) {
      if (el.tagName === 'SPAN' && el.style && el.style.textTransform === 'uppercase') {
        return el;
      }
      el = el.parentElement;
    }
    return null;
  }
  function unwrapElement(el) {
    const parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  // Reflete visualmente se o bloco atual está em uppercase (botão fica "ativo")
  function updateAllCapsState() {
    const btn = document.getElementById('btn-allcaps');
    if (!btn) return;
    const ctx = getLineHeightContext();
    if (!ctx) {
      btn.classList.remove('active');
      return;
    }
    btn.classList.toggle('active', getComputedStyle(ctx.element).textTransform === 'uppercase');
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

  // ---------- zoom do documento ----------
  function applyZoom(z) {
    z = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));
    z = Math.round(z * 100) / 100;
    currentZoom = z;
    HOST.style.transform = (z === 1) ? '' : `scale(${z})`;
    HOST.style.transformOrigin = 'top center';
    // Estado dos botões — desabilita quando bate no limite
    if (btnZoomIn)  btnZoomIn.disabled  = (z >= ZOOM_MAX);
    if (btnZoomOut) btnZoomOut.disabled = (z <= ZOOM_MIN);
    // Atualiza o indicador de %
    if (zoomValueBtn) zoomValueBtn.textContent = Math.round(z * 100) + '%';
    try { localStorage.setItem(ZOOM_KEY, String(z)); } catch (e) {}
  }
  function initZoom() {
    let z = 1.0;
    try {
      const saved = localStorage.getItem(ZOOM_KEY);
      if (saved) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed)) z = parsed;
      }
    } catch (e) {}
    applyZoom(z);
  }

  // ---------- inicialização ----------
  async function init() {
    // TEMA — descomenta pra reativar (2/3)
    // initTheme();

    // Zoom
    initZoom();
    btnZoomIn.addEventListener('click', () => applyZoom(currentZoom + ZOOM_STEP));
    btnZoomOut.addEventListener('click', () => applyZoom(currentZoom - ZOOM_STEP));
    zoomValueBtn.addEventListener('click', () => applyZoom(1.0));
    // Atalhos de teclado: Cmd/Ctrl + e Cmd/Ctrl -
    document.addEventListener('keydown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); applyZoom(currentZoom + ZOOM_STEP); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); applyZoom(currentZoom - ZOOM_STEP); }
      else if (e.key === '0') { e.preventDefault(); applyZoom(1.0); }
    });
    // Cmd/Ctrl + scroll do mouse — zoom in/out (pega também pinch do trackpad)
    document.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const step = ZOOM_STEP * (Math.abs(e.deltaY) > 50 ? 1 : 0.5);
      applyZoom(currentZoom + (e.deltaY < 0 ? step : -step));
    }, { passive: false });

    // ----- Modo "pan" (segurar espaço pra arrastar a artboard) -----
    let spaceHeld = false;
    let isPanning = false;
    let panLastX = 0, panLastY = 0;

    function isEditingText() {
      const ae = document.activeElement;
      if (!ae) return false;
      if (ae.isContentEditable) return true;
      const tag = ae.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    document.addEventListener('keydown', (e) => {
      if (e.code !== 'Space') return;
      // Se está editando texto, deixa o espaço ser digitado normalmente
      if (isEditingText()) return;
      e.preventDefault(); // evita que o navegador role a página
      if (!spaceHeld) {
        spaceHeld = true;
        document.body.classList.add('pan-mode');
      }
    });
    document.addEventListener('keyup', (e) => {
      if (e.code !== 'Space') return;
      spaceHeld = false;
      document.body.classList.remove('pan-mode');
      // Se estava arrastando, encerra
      if (isPanning) {
        isPanning = false;
        document.body.classList.remove('panning');
      }
    });

    document.addEventListener('mousedown', (e) => {
      if (!spaceHeld) return;
      // Ignora clique em controles da chrome (toolbar, zoom-controls, popup)
      if (e.target.closest('.toolbar, .zoom-controls, .format-popup, .dropdown-menu, .popup-dropdown-menu')) return;
      isPanning = true;
      panLastX = e.clientX;
      panLastY = e.clientY;
      document.body.classList.add('panning');
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!isPanning) return;
      const dx = e.clientX - panLastX;
      const dy = e.clientY - panLastY;
      panLastX = e.clientX;
      panLastY = e.clientY;
      window.scrollBy(-dx, -dy);
    });
    document.addEventListener('mouseup', () => {
      if (isPanning) {
        isPanning = false;
        document.body.classList.remove('panning');
      }
    });
    // Sair da janela cancela o pan
    document.addEventListener('mouseleave', () => {
      if (isPanning) {
        isPanning = false;
        document.body.classList.remove('panning');
      }
    });
    // Se o foco sair do documento (ex.: alt-tab), cancela tudo
    window.addEventListener('blur', () => {
      spaceHeld = false;
      isPanning = false;
      document.body.classList.remove('pan-mode', 'panning');
    });

    btnEdit.addEventListener('click', toggleEdit);
    btnMove.addEventListener('click', toggleDragMode);
    btnPrint.addEventListener('click', doPrint);

    // Drag-and-drop handlers (passa a escutar sempre, atividade gated por dragMode)
    setupDragHandlers();
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
      updateAllCapsState();
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

    // Botões de kerning (letter-spacing)
    trackingMinus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!currentLyricBlock) return;
      setTrackingValue(currentLyricBlock, getTrackingValue(currentLyricBlock) - TRACKING_STEP);
    });
    trackingPlus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (!currentLyricBlock) return;
      setTrackingValue(currentLyricBlock, getTrackingValue(currentLyricBlock) + TRACKING_STEP);
    });

    // Botões de entrelinha (line-height) — usam contexto PER-BLOCO próprio,
    // pra afetar só o parágrafo onde o cursor está, não a coluna toda
    lineHeightMinus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const lineCtx = getLineHeightContext();
      if (!lineCtx) return;
      setLineHeightValue(lineCtx, getLineHeightValue(lineCtx) - LH_STEP);
    });
    lineHeightPlus.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const lineCtx = getLineHeightContext();
      if (!lineCtx) return;
      setLineHeightValue(lineCtx, getLineHeightValue(lineCtx) + LH_STEP);
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
