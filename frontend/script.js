// Determina a URL da API dinamicamente para funcionar via localhost, IP da rede local ou domínio
const API_URL = window.location.protocol.startsWith('http')
  ? `${window.location.protocol}//${window.location.hostname}:3000/api`
  : 'http://localhost:3000/api';

const state = {
  usuario: JSON.parse(localStorage.getItem('bipa_usuario') || 'null'),
  token: localStorage.getItem('bipa_token') || null,
  dashboard: null,
  materiais: [],
  cameraStream: null,
  usandoCameraServidor: true,
  previewTimer: null,
  relayTimer: null,
  candyQty: 1,
  ultimoComprovante: null,
  imagemCapturadaBase64: null
};

const $ = (selector) => document.querySelector(selector);

/* =========================================================
   UTILITÁRIOS
========================================================= */

function escapeHTML(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[char])
  );
}

function formatPoints(value) {
  return Number(value || 0).toLocaleString('pt-BR');
}

function initials(nome = 'Aluno') {
  return nome
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase();
}

function formatCPF(valor = '') {
  let v = String(valor).replace(/\D/g, '').slice(0, 11);
  if (v.length > 9) {
    return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6, 9)}-${v.slice(9)}`;
  } else if (v.length > 6) {
    return `${v.slice(0, 3)}.${v.slice(3, 6)}.${v.slice(6)}`;
  } else if (v.length > 3) {
    return `${v.slice(0, 3)}.${v.slice(3)}`;
  }
  return v;
}

function maskCPF(valor = '') {
  const digits = String(valor).replace(/\D/g, '');
  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }
  return valor;
}

/* =========================================================
   TOASTS
========================================================= */

function showToast(message, type = 'success') {
  const container = $('#toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✓' : '!'}</span>
    <p>${escapeHTML(message)}</p>
  `;

  container.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('out');
    setTimeout(() => toast.remove(), 250);
  }, 4000);
}

/* =========================================================
   TEMA
========================================================= */

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('bipa_theme', theme);

  const button = $('#btn-theme');
  if (button) {
    button.textContent = theme === 'dark' ? '☀' : '☾';
  }
}

function initTheme() {
  const saved = localStorage.getItem('bipa_theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  setTheme(saved || (prefersDark ? 'dark' : 'light'));
}

/* =========================================================
   API CLIENT
========================================================= */

async function api(endpoint, options = {}) {
  const headers = {
    ...(options.headers || {})
  };

  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  if (options.body && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({
    sucesso: false,
    mensagem: 'Resposta inválida do servidor.'
  }));

  if (!response.ok || data.sucesso === false) {
    throw new Error(data.mensagem || data.erro || 'Ocorreu um erro na comunicação com a API.');
  }

  return data;
}

/* =========================================================
   MODAIS & CONTROLE DE TELA
========================================================= */

function openModal(id) {
  const modal = $(id);
  if (!modal) return;

  modal.classList.remove('hidden');
  document.body.classList.add('modal-open');
}

function closeAllModals() {
  stopCamera();

  document.querySelectorAll('.modal').forEach((modal) => {
    modal.classList.add('hidden');
  });

  document.body.classList.remove('modal-open');
}

/* =========================================================
   AUTENTICAÇÃO & SESSÃO (CPF DIRETO)
========================================================= */

function updateAuthUI() {
  const loggedIn = Boolean(state.usuario && state.token);

  const loginScreen = $('#login-screen');
  const appScreen = $('#app-screen');

  if (!loginScreen || !appScreen) return;

  if (loggedIn) {
    loginScreen.classList.add('hidden');
    appScreen.classList.remove('hidden');

    const name = state.usuario.nome || 'Aluno';
    const firstName = name.split(' ')[0];

    if ($('#user-menu-name')) $('#user-menu-name').textContent = firstName;
    if ($('#user-avatar')) $('#user-avatar').textContent = initials(name);
    if ($('#dashboard-name')) $('#dashboard-name').textContent = firstName;
    if ($('#profile-title')) $('#profile-title').textContent = name;
    if ($('#profile-avatar')) $('#profile-avatar').textContent = initials(name);
    if ($('#profile-cpf-text')) $('#profile-cpf-text').textContent = `CPF: ${state.usuario.cpf_mascarado || maskCPF(state.usuario.cpf)}`;
    if ($('#balance-points')) $('#balance-points').textContent = formatPoints(state.usuario.pontos);

    updateCandyBadge();
  } else {
    appScreen.classList.add('hidden');
    loginScreen.classList.remove('hidden');
  }
}

function saveSession(usuario, token) {
  state.usuario = usuario;
  state.token = token;

  localStorage.setItem('bipa_usuario', JSON.stringify(usuario));
  localStorage.setItem('bipa_token', token);

  updateAuthUI();
}

function logout() {
  stopCamera();
  state.usuario = null;
  state.token = null;
  state.dashboard = null;

  localStorage.removeItem('bipa_usuario');
  localStorage.removeItem('bipa_token');

  $('#user-dropdown')?.classList.add('hidden');

  updateAuthUI();
  showToast('Você saiu da sua carteira.');

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function handleAuth(event) {
  event.preventDefault();

  const cpfInput = $('#input-cpf');
  const nameInput = $('#input-name');
  const errorEl = $('#auth-error');

  if (errorEl) errorEl.textContent = '';

  const cpfLimpo = (cpfInput?.value || '').replace(/\D/g, '');
  const nome = nameInput?.value?.trim() || '';

  if (cpfLimpo.length !== 11) {
    if (errorEl) errorEl.textContent = 'Digite um CPF válido com 11 números.';
    return;
  }

  const submitBtn = $('#auth-submit-button');
  const submitText = $('#auth-submit-text');
  const originalText = submitText ? submitText.textContent : 'Acessar';

  if (submitBtn) submitBtn.disabled = true;
  if (submitText) submitText.textContent = 'Acessando carteira...';

  try {
    const data = await api('/auth/cpf', {
      method: 'POST',
      body: JSON.stringify({
        cpf: cpfLimpo,
        nome: nome || undefined
      })
    });

    saveSession(data.usuario, data.token);

    $('#auth-form')?.reset();
    showToast(data.mensagem || `Olá, ${data.usuario.nome.split(' ')[0]}!`);

    await carregarDashboard();
  } catch (error) {
    if (errorEl) errorEl.textContent = error.message;
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (submitText) submitText.textContent = originalText;
  }
}

function formatCPFInput(event) {
  event.target.value = formatCPF(event.target.value);
}

/* =========================================================
   LIXEIRA INTELIGENTE: WEBCAM + CAPTURA + OPENAI + ESP32
========================================================= */

function stopCamera() {
  if (state.previewTimer) {
    clearInterval(state.previewTimer);
    state.previewTimer = null;
  }

  if (state.relayTimer) {
    clearInterval(state.relayTimer);
    state.relayTimer = null;
  }

  const streamImg = $('#lixeira-stream');
  if (streamImg) {
    streamImg.onload = null;
    streamImg.onerror = null;
    streamImg.removeAttribute('src');
  }

  if (state.cameraStream) {
    state.cameraStream.getTracks().forEach((track) => track.stop());
    state.cameraStream = null;
  }
}

async function startLocalWebcamFallback() {
  const video = $('#webcam');
  const streamImg = $('#lixeira-stream');
  const errorBox = $('#camera-error-box');
  const sourceLabel = $('#camera-source-label');

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'environment',
        width: { ideal: 640 },
        height: { ideal: 480 }
      }
    });

    state.cameraStream = stream;
    state.usandoCameraServidor = false;

    if (streamImg) streamImg.classList.add('hidden');
    if (video) {
      video.classList.remove('hidden');
      video.srcObject = stream;
      await video.play();
    }
    if (sourceLabel) sourceLabel.textContent = 'CÂMERA CONECTADA';

    // Se estiver rodando no PC servidor (localhost), retransmite os quadros para que celulares na rede também vejam!
    const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    if (isLocalHost) {
      state.relayTimer = setInterval(() => {
        const frame = captureFrameFromLocalVideoOnly();
        if (frame) {
          fetch(`${API_URL}/camera/frame`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ imagemBase64: frame })
          }).catch(() => {});
        }
      }, 280);
    }
  } catch (err) {
    console.warn('Erro ao acessar câmera local:', err);
    if (errorBox) errorBox.classList.remove('hidden');
  }
}

async function startCamera() {
  const video = $('#webcam');
  const streamImg = $('#lixeira-stream');
  const errorBox = $('#camera-error-box');
  const sourceLabel = $('#camera-source-label');

  if (errorBox) errorBox.classList.add('hidden');
  stopCamera();

  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);

  // Se estiver no próprio PC servidor (localhost), abre a câmera USB direto via WebRTC e retransmite para a rede
  if (isLocalHost && navigator.mediaDevices?.getUserMedia) {
    await startLocalWebcamFallback();
    return;
  }

  // Em celulares e outros dispositivos na rede, exibe a Câmera Fixa da Lixeira transmitida pelo servidor!
  state.usandoCameraServidor = true;
  if (sourceLabel) sourceLabel.textContent = 'CÂMERA FIXA DA LIXEIRA';

  if (streamImg && video) {
    video.classList.add('hidden');
    streamImg.classList.remove('hidden');
    streamImg.crossOrigin = 'anonymous';

    let streamLoaded = false;

    streamImg.onload = () => {
      streamLoaded = true;
      if (errorBox) errorBox.classList.add('hidden');
    };

    streamImg.onerror = () => {
      if (!streamLoaded) {
        startLocalWebcamFallback();
      }
    };

    streamImg.src = `${API_URL}/camera/stream?t=${Date.now()}`;

    // Mantém em paralelo uma cópia atualizada em Base64 via /camera/preview para disparo instantâneo
    const fetchPreviewFrame = async () => {
      if (!state.usandoCameraServidor) return;
      try {
        const res = await fetch(`${API_URL}/camera/preview?t=${Date.now()}`);
        const data = await res.json();
        if (data.sucesso && data.imagemBase64) {
          state.imagemCapturadaBase64 = data.imagemBase64;
          if (!streamLoaded && streamImg) {
            streamImg.src = data.imagemBase64;
            streamLoaded = true;
          }
        }
      } catch (_e) {}
    };

    fetchPreviewFrame();
    state.previewTimer = setInterval(fetchPreviewFrame, 1000);
  } else {
    await startLocalWebcamFallback();
  }
}

function openDepositModal() {
  state.imagemCapturadaBase64 = null;

  // Reseta visual dos passos
  $('#deposit-step-camera')?.classList.remove('hidden');
  $('#deposit-step-processing')?.classList.add('hidden');
  $('#deposit-step-success')?.classList.add('hidden');

  const btnDone = $('#btn-done-deposit');
  if (btnDone) {
    btnDone.disabled = false;
    btnDone.innerHTML = '<span>📸 Feito! Tirar foto e descartar</span>';
  }

  openModal('#deposit-modal');
  startCamera();
}

function captureFrameFromLocalVideoOnly() {
  const video = $('#webcam');
  const canvas = $('#camera-canvas');
  if (!video || !canvas || video.classList.contains('hidden') || !video.videoWidth) return null;

  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;

  canvas.width = w;
  canvas.height = h;

  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);

  return canvas.toDataURL('image/jpeg', 0.85);
}

// Captura frame do visor ativo (stream da lixeira ou vídeo local) para o canvas e gera Base64
function captureFrameFromVideo() {
  const canvas = $('#camera-canvas');
  const streamImg = $('#lixeira-stream');

  // 1. Se o visor de stream da câmera da lixeira estiver visível e carregado, extrai o quadro dele
  if (
    state.usandoCameraServidor &&
    streamImg &&
    !streamImg.classList.contains('hidden') &&
    streamImg.naturalWidth > 0 &&
    canvas
  ) {
    try {
      canvas.width = streamImg.naturalWidth || 640;
      canvas.height = streamImg.naturalHeight || 480;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(streamImg, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.85);
    } catch (_e) {
      // Caso o navegador restrinja leitura do canvas, usa o frame Base64 atualizado pelo preview
    }
  }

  // 2. Se houver vídeo local ativo (<video id="webcam">)
  const localFrame = captureFrameFromLocalVideoOnly();
  if (localFrame) return localFrame;

  // 3. Fallback para último frame Base64 recebido do servidor ou upload
  return state.imagemCapturadaBase64 || null;
}

async function handleDoneDeposit() {
  if (!state.usuario?.id) {
    showToast('Você precisa estar logado para acumular pontos.', 'error');
    return;
  }

  const imagemBase64 = captureFrameFromVideo();
  const usarCameraLixeira = Boolean(state.usandoCameraServidor || !imagemBase64);

  // Desativa câmera durante o envio
  stopCamera();

  // Transiciona para o passo de carregamento
  $('#deposit-step-camera')?.classList.add('hidden');
  $('#deposit-step-processing')?.classList.remove('hidden');

  try {
    const data = await api('/reciclagens/descartar', {
      method: 'POST',
      body: JSON.stringify({
        usuario_id: state.usuario.id,
        imagemBase64,
        usarCameraLixeira
      })
    });

    if (data.sucesso && data.material && data.material !== 'Desconhecido') {
      // Sucesso: material reconhecido, ESP32 acionado e 50 pontos ganhos
      $('#deposit-step-processing')?.classList.add('hidden');
      $('#deposit-step-success')?.classList.remove('hidden');

      // Preenche os dados de retorno (usa a foto capturada pelo servidor na lixeira ou a local)
      const imgPreview = $('#result-photo-preview');
      if (imgPreview) {
        imgPreview.src = data.imagemBase64 || imagemBase64 || data.foto_url || '';
      }

      const badge = $('#result-material-badge');
      if (badge) {
        badge.textContent = data.material;
        badge.className = `result-badge mat-${data.material.toLowerCase()}`;
      }

      const desc = $('#result-description');
      if (desc) desc.textContent = data.descricao || `Descarte de ${data.material} registrado com sucesso.`;

      const espStatus = $('#result-esp-status');
      if (espStatus) espStatus.textContent = `📡 ${data.esp32Status || 'ESP32 acionado'}`;

      const earnedVal = $('#earned-points-val');
      if (earnedVal) earnedVal.textContent = `+${formatPoints(data.pontos_ganhos || 50)} pts`;

      showToast(`🎉 +50 pontos adicionados! Material: ${data.material}`);
      await carregarDashboard();
    } else {
      // Material não identificado ou outro problema
      $('#deposit-step-processing')?.classList.add('hidden');
      $('#deposit-step-camera')?.classList.remove('hidden');
      startCamera();

      showToast(
        data.mensagem || 'Não conseguimos identificar o material como Plástico, Papel ou Metal. Tente novamente!',
        'error'
      );
    }
  } catch (error) {
    $('#deposit-step-processing')?.classList.add('hidden');
    $('#deposit-step-camera')?.classList.remove('hidden');
    startCamera();

    showToast(error.message || 'Erro ao processar imagem na IA.', 'error');
  }
}

// Fallback de envio por arquivo
function handleFallbackFileInput(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    state.imagemCapturadaBase64 = e.target.result;
    state.usandoCameraServidor = false;
    const streamImg = $('#lixeira-stream');
    if (streamImg) {
      streamImg.classList.remove('hidden');
      streamImg.src = state.imagemCapturadaBase64;
    }
    showToast('Foto carregada do dispositivo! Clique em Feito para analisar.');
  };
  reader.readAsDataURL(file);
}

/* =========================================================
   TROCA DE PONTOS POR BALAS (40 PTS CADA)
========================================================= */

function updateCandyBadge() {
  const points = Number(state.usuario?.pontos || 0);
  const possibleCandies = Math.floor(points / 40);

  const textEl = $('#available-candies-text');
  if (textEl) {
    if (possibleCandies === 0) {
      textEl.textContent = 'Junte 40 pts para retirar 1 bala';
    } else if (possibleCandies === 1) {
      textEl.textContent = '1 bala disponível para troca!';
    } else {
      textEl.textContent = `${possibleCandies} balas disponíveis para troca!`;
    }
  }
}

function updateCandyModalCalculation() {
  const userPoints = Number(state.usuario?.pontos || 0);
  const unitCost = Number(state.selectedReward?.pontos_necessarios || 40);
  const rewardName = state.selectedReward?.titulo || 'Bala';
  const totalCost = state.candyQty * unitCost;

  if ($('#candy-modal-title')) {
    $('#candy-modal-title').textContent = `Trocar pontos por ${rewardName.toLowerCase()}`;
  }
  const subtitle = $('.candy-modal-subtitle');
  if (subtitle) {
    subtitle.innerHTML = `Cada <strong>${escapeHTML(rewardName)}</strong> custa <strong>${unitCost} pontos</strong>. Escolha a quantidade desejada:`;
  }
  const unitLabel = $('.counter-value span');
  if (unitLabel) {
    unitLabel.textContent = `${rewardName.toLowerCase()}(s)`;
  }

  if ($('#candy-qty-display')) $('#candy-qty-display').textContent = state.candyQty;
  if ($('#candy-total-points-cost')) $('#candy-total-points-cost').textContent = `${formatPoints(totalCost)} pts`;
  if ($('#candy-user-balance-display')) $('#candy-user-balance-display').textContent = `${formatPoints(userPoints)} pts`;

  const alertBox = $('#candy-alert-box');
  const confirmBtn = $('#btn-confirm-candy-exchange');

  if (userPoints < totalCost) {
    const diff = totalCost - userPoints;
    if (alertBox) {
      alertBox.textContent = `Faltam ${diff} ponto(s) para resgatar ${state.candyQty} ${rewardName.toLowerCase()}(s). Descarte mais resíduos para pontuar!`;
      alertBox.classList.remove('hidden');
    }
    if (confirmBtn) confirmBtn.disabled = true;
  } else {
    if (alertBox) alertBox.classList.add('hidden');
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

function openCandyModal(reward = null) {
  state.selectedReward = reward && reward.titulo
    ? reward
    : { id: null, titulo: 'Bala', pontos_necessarios: 40 };
  state.candyQty = 1;
  updateCandyModalCalculation();
  openModal('#candy-modal');
}

function handleCandyMinus() {
  if (state.candyQty > 1) {
    state.candyQty -= 1;
    updateCandyModalCalculation();
  }
}

function handleCandyPlus() {
  const userPoints = Number(state.usuario?.pontos || 0);
  const unitCost = Number(state.selectedReward?.pontos_necessarios || 40);
  const maxPossible = Math.max(1, Math.floor(userPoints / unitCost));

  if (state.candyQty < maxPossible) {
    state.candyQty += 1;
  } else {
    state.candyQty += 1; // Permite subir para mostrar o aviso de saldo insuficiente
  }
  updateCandyModalCalculation();
}

async function confirmCandyExchange() {
  if (!state.usuario?.id) return;

  const unitCost = Number(state.selectedReward?.pontos_necessarios || 40);
  const rewardName = state.selectedReward?.titulo || 'Bala';
  const totalCost = state.candyQty * unitCost;
  const userPoints = Number(state.usuario?.pontos || 0);

  if (userPoints < totalCost) {
    showToast(`Você precisa de ${totalCost} pontos para retirar ${state.candyQty} ${rewardName.toLowerCase()}(s).`, 'error');
    return;
  }

  const btn = $('#btn-confirm-candy-exchange');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Gerando comprovante...';
  }

  try {
    const data = await api('/resgates/balas', {
      method: 'POST',
      body: JSON.stringify({
        usuario_id: state.usuario.id,
        recompensa_id: state.selectedReward?.id || undefined,
        quantidade: state.candyQty
      })
    });

    closeAllModals();
    showToast(data.mensagem || 'Resgate realizado com sucesso!');

    // Abre o comprovante oficial
    if (data.comprovante) {
      openVoucherModal(data.comprovante);
    }

    await carregarDashboard();
  } catch (error) {
    showToast(error.message, 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Trocar e Gerar Comprovante';
    }
  }
}

/* =========================================================
   COMPROVANTE OFICIAL DE TROCA DE BALAS
========================================================= */

function openVoucherModal(comprovante) {
  if (!comprovante) return;

  state.ultimoComprovante = comprovante;

  if ($('#voucher-code')) $('#voucher-code').textContent = `#${comprovante.codigo}`;
  if ($('#voucher-date')) $('#voucher-date').textContent = comprovante.data;
  if ($('#voucher-student-name')) $('#voucher-student-name').textContent = comprovante.usuario_nome;
  if ($('#voucher-student-cpf')) $('#voucher-student-cpf').textContent = comprovante.usuario_cpf_mascarado || maskCPF(comprovante.usuario_cpf);
  if ($('#voucher-candies-qty')) {
    const itemTitle = comprovante.recompensa || 'Bala';
    $('#voucher-candies-qty').textContent = `${comprovante.quantidade} ${itemTitle}(s) ${rewardIcon(itemTitle)}`;
  }
  if ($('#voucher-points-spent')) $('#voucher-points-spent').textContent = `${formatPoints(comprovante.pontos_gastos)} pontos`;
  if ($('#voucher-status')) $('#voucher-status').textContent = `🟢 ${comprovante.status || 'Válido para troca'}`;

  openModal('#voucher-modal');
}

async function viewVoucherByCode(codigo) {
  try {
    const data = await api(`/comprovante/${encodeURIComponent(codigo)}`);
    if (data.comprovante) {
      openVoucherModal(data.comprovante);
    }
  } catch (error) {
    showToast('Não foi possível carregar o comprovante.', 'error');
  }
}

/* =========================================================
   HISTÓRICO E EXTRATO
========================================================= */

function renderHistory(reciclagens = [], resgates = []) {
  const container = $('#history-list');
  if (!container) return;

  const movements = [
    ...reciclagens.map((item) => ({
      type: 'recycle',
      title: `Reciclagem com IA: ${item.material}`,
      description: `${item.data || 'Hoje'} • ${item.status_esp32 || 'ESP32 acionado'}`,
      points: `+${formatPoints(item.pontos_ganhos || 50)}`,
      timestamp: Number(item.timestamp || 0),
      codigo: null,
      raw: item
    })),
    ...resgates.map((item) => ({
      type: 'redeem',
      title: `Resgate de ${item.quantidade || 1}x ${item.titulo || 'Bala'}`,
      description: `${item.data || 'Hoje'} • Código: #${item.codigo_comprovante}`,
      points: `-${formatPoints(item.pontos_gastos || (item.quantidade || 1) * 40)}`,
      timestamp: Number(item.timestamp || 0),
      codigo: item.codigo_comprovante,
      raw: item
    }))
  ].sort((a, b) => b.timestamp - a.timestamp);

  if (!movements.length) {
    container.innerHTML = `
      <div class="empty-state">
        <div>♻️</div>
        <strong>Seu histórico está começando.</strong>
        <p>Quando você descartar na lixeira inteligente ou trocar seus pontos por balas, tudo aparecerá aqui.</p>
      </div>
    `;
    return;
  }

  container.innerHTML = movements
    .slice(0, 15)
    .map(
      (item) => `
        <div class="history-item">
          <span class="history-icon ${item.type}">
            ${item.type === 'recycle' ? '♻️' : '🍬'}
          </span>

          <div class="history-info">
            <strong>${escapeHTML(item.title)}</strong>
            <span>${escapeHTML(item.description)}</span>
            ${
              item.codigo
                ? `<button class="btn-link-voucher" type="button" data-view-voucher="${escapeHTML(item.codigo)}">
                     🎟️ Ver Comprovante
                   </button>`
                : ''
            }
          </div>

          <strong class="movement-points ${item.type === 'redeem' ? 'negative' : ''}">
            ${item.points} pts
          </strong>
        </div>
      `
    )
    .join('');

  // Eventos para abrir comprovante do histórico
  container.querySelectorAll('[data-view-voucher]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const codigo = btn.dataset.viewVoucher;
      if (codigo) viewVoucherByCode(codigo);
    });
  });
}

/* =========================================================
   RANKING
========================================================= */

function renderRanking(ranking = []) {
  const container = $('#ranking-list');
  if (!container) return;

  if (!ranking.length) {
    container.innerHTML = `
      <div class="empty-state">
        <strong>Ninguém no ranking ainda. Seja o primeiro a reciclar!</strong>
      </div>
    `;
    return;
  }

  container.innerHTML = ranking
    .map(
      (item) => `
        <div class="ranking-item ${
          state.usuario && Number(item.id) === Number(state.usuario.id) ? 'current' : ''
        }">
          <span class="rank-position">
            ${
              item.posicao <= 3
                ? ['🥇', '🥈', '🥉'][item.posicao - 1]
                : `#${item.posicao}`
            }
          </span>

          <span class="rank-avatar">
            ${initials(item.nome)}
          </span>

          <div class="rank-name">
            <strong>${escapeHTML(item.nome)}</strong>
            ${Number(item.id) === Number(state.usuario?.id) ? '<small>Você</small>' : ''}
          </div>

          <strong>${formatPoints(item.pontos)} pts</strong>
        </div>
      `
    )
    .join('');

  const me = ranking.find((item) => Number(item.id) === Number(state.usuario?.id));

  if ($('#user-position')) $('#user-position').textContent = me ? `#${me.posicao}` : '—';
  if ($('#profile-rank')) $('#profile-rank').textContent = me ? `#${me.posicao}` : '—';
}

/* =========================================================
   CATÁLOGO DE RECOMPENSAS
========================================================= */

function renderRewards(rewards = []) {
  const container = $('#rewards-grid');
  if (!container) return;

  const saldo = Number(state.usuario?.pontos || 0);

  // Garante que a recompensa de Bala esteja presente
  const rewardsList = rewards.length
    ? rewards
    : [{ id: 1, titulo: 'Bala', pontos_necessarios: 40, estoque: 1000 }];

  container.innerHTML = rewardsList
    .map((reward) => {
      const isBala = reward.titulo.toLowerCase().includes('bala');
      const pontos = Number(reward.pontos_necessarios);
      const canRedeem = saldo >= pontos && Number(reward.estoque) > 0;

      return `
        <article class="reward-card ${isBala ? 'card-featured-candy' : ''}">
          <div class="reward-visual">
            ${rewardIcon(reward.titulo)}
          </div>

          <div class="reward-content">
            <span class="reward-stock ${Number(reward.estoque) <= 0 ? 'empty' : ''}">
              ${Number(reward.estoque) <= 0 ? 'ESGOTADO' : `${reward.estoque} un disponíveis`}
            </span>

            <h4>${escapeHTML(reward.titulo)}</h4>

            <div class="reward-bottom">
              <strong>${formatPoints(pontos)} pts</strong>

              <button
                class="btn btn-small ${canRedeem ? 'btn-primary' : 'btn-disabled'}"
                type="button"
                data-redeem-action="${isBala ? 'candy' : 'standard'}"
                data-reward-id="${reward.id}"
                ${canRedeem ? '' : 'disabled'}
              >
                ${
                  Number(reward.estoque) <= 0
                    ? 'Esgotado'
                    : saldo < pontos
                    ? 'Faltam pontos'
                    : 'Trocar pontos'
                }
              </button>
            </div>
          </div>
        </article>
      `;
    })
    .join('');

  // Cliques nos botões de recompensas
  container.querySelectorAll('[data-redeem-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const rId = Number(btn.dataset.rewardId);
      const selected = rewardsList.find((r) => Number(r.id) === rId) || null;
      openCandyModal(selected);
    });
  });
}

function rewardIcon(title = '') {
  const text = title.toLowerCase();
  if (text.includes('bala')) return '🍬';
  if (text.includes('pirulito')) return '🍭';
  if (text.includes('bombom')) return '🍫';
  return '🎁';
}

/* =========================================================
   MATERIAIS ACEITOS PELA LIXEIRA INTELIGENTE
========================================================= */

function renderMaterials(materials = []) {
  const container = $('#materials-grid');
  if (!container) return;

  const lista = materials.length
    ? materials
    : [
        { nome: 'Plastico', pontos_por_descarte: 50 },
        { nome: 'Metal', pontos_por_descarte: 50 },
        { nome: 'Papel', pontos_por_descarte: 50 }
      ];

  container.innerHTML = lista
    .map(
      (m) => `
        <article class="material-card mat-card-${m.nome.toLowerCase()}">
          <span class="material-icon">
            ${materialIcon(m.nome)}
          </span>

          <div>
            <strong>${escapeHTML(m.nome)}</strong>
            <span>+${formatPoints(m.pontos_por_descarte || 50)} pontos por descarte</span>
          </div>
        </article>
      `
    )
    .join('');
}

function materialIcon(nome = '') {
  const text = nome.toLowerCase();
  if (text.includes('metal')) return '🥫';
  if (text.includes('papel')) return '📄';
  return '🧴';
}

/* =========================================================
   CARREGAR DASHBOARD
========================================================= */

async function carregarDashboard() {
  if (!state.usuario?.id) return;

  try {
    const data = await api(`/dashboard/${state.usuario.id}`);
    state.dashboard = data;

    // Atualiza saldo local do usuário
    state.usuario.pontos = data.usuario.pontos;
    state.usuario.nome = data.usuario.nome;
    state.usuario.cpf_mascarado = data.usuario.cpf_mascarado;
    localStorage.setItem('bipa_usuario', JSON.stringify(state.usuario));

    if ($('#balance-points')) $('#balance-points').textContent = formatPoints(data.usuario.pontos);
    if ($('#profile-points')) $('#profile-points').textContent = formatPoints(data.usuario.pontos);
    if ($('#total-recycling')) $('#total-recycling').textContent = data.reciclagens?.length || 0;

    updateCandyBadge();
    renderHistory(data.reciclagens || [], data.resgates || []);
    renderRanking(data.ranking || []);
    renderRewards(data.recompensas || []);
  } catch (error) {
    showToast(error.message, 'error');
    if (error.message.toLowerCase().includes('usuário não encontrado')) {
      logout();
    }
  }
}

async function carregarMateriais() {
  try {
    const data = await api('/materiais');
    state.materiais = data.materiais || [];
    renderMaterials(state.materiais);
  } catch (error) {
    renderMaterials([]);
  }
}

/* =========================================================
   EVENTOS E BINDINGS
========================================================= */

function bindEvents() {
  // Alternância de Tema
  $('#btn-theme')?.addEventListener('click', () => {
    const current = document.documentElement.dataset.theme;
    setTheme(current === 'dark' ? 'light' : 'dark');
  });

  // Autenticação com CPF
  $('#auth-form')?.addEventListener('submit', handleAuth);
  $('#input-cpf')?.addEventListener('input', formatCPFInput);

  // Ações de Depósito de Lixo (Câmera + IA + ESP32)
  $('#btn-quick-deposit')?.addEventListener('click', openDepositModal);
  $('#btn-done-deposit')?.addEventListener('click', handleDoneDeposit);
  $('#fallback-file-input')?.addEventListener('change', handleFallbackFileInput);
  $('#btn-another-deposit')?.addEventListener('click', openDepositModal);
  $('#btn-finish-deposit')?.addEventListener('click', closeAllModals);

  // Ações de Troca por Balas
  $('#btn-quick-candy-exchange')?.addEventListener('click', openCandyModal);
  $('#btn-quick-candies')?.addEventListener('click', openCandyModal);
  $('#btn-candy-minus')?.addEventListener('click', handleCandyMinus);
  $('#btn-candy-plus')?.addEventListener('click', handleCandyPlus);
  $('#btn-confirm-candy-exchange')?.addEventListener('click', confirmCandyExchange);

  // Fechar modais
  document.addEventListener('click', (event) => {
    if (event.target.matches('[data-close-modal]')) {
      closeAllModals();
    }
  });

  // Menu do usuário
  $('#btn-user-menu')?.addEventListener('click', (event) => {
    event.stopPropagation();
    $('#user-dropdown')?.classList.toggle('hidden');
  });

  document.addEventListener('click', (event) => {
    if (!event.target.closest('.user-menu')) {
      $('#user-dropdown')?.classList.add('hidden');
    }
  });

  $('#btn-logout')?.addEventListener('click', logout);
  $('#btn-my-profile')?.addEventListener('click', () => {
    $('#user-dropdown')?.classList.add('hidden');
    openModal('#profile-modal');
  });

  // Atualizar manual
  $('#btn-refresh')?.addEventListener('click', async () => {
    const btn = $('#btn-refresh');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '🔄 Atualizando...';
    }
    await carregarDashboard();
    if (btn) {
      btn.disabled = false;
      btn.textContent = '🔄 Atualizar';
    }
  });

  // Scroll suave dos atalhos
  document.querySelectorAll('[data-scroll-to]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.scrollTo);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Tecla ESC fecha modais e desliga webcam
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeAllModals();
  });
}

function initSplash() {
  const splash = $('#site-splash');
  if (!splash) return;

  const duration = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 350 : 1200;
  setTimeout(() => {
    splash.classList.add('is-hidden');
    setTimeout(() => splash.remove(), 400);
  }, duration);
}

/* =========================================================
   PONTE AUTOMÁTICA DA CÂMERA NO PC SERVIDOR (LOCALHOST)
   Se o site estiver aberto no PC onde a câmera está plugada,
   fornece o vídeo automaticamente quando um celular pedir
========================================================= */

function initServerCameraRelayBridge() {
  const isLocalHost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  if (!isLocalHost || !navigator.mediaDevices?.getUserMedia) return;

  let bgStream = null;
  let bgVideo = null;
  let bgCanvas = null;
  let bgSendTimer = null;

  async function stopBgRelay() {
    if (bgSendTimer) {
      clearInterval(bgSendTimer);
      bgSendTimer = null;
    }
    if (bgStream) {
      bgStream.getTracks().forEach((t) => t.stop());
      bgStream = null;
    }
  }

  async function startBgRelay() {
    if (bgStream || state.cameraStream) return;
    try {
      bgStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 } }
      });

      if (!bgVideo) {
        bgVideo = document.createElement('video');
        bgVideo.muted = true;
        bgVideo.playsInline = true;
      }
      if (!bgCanvas) {
        bgCanvas = document.createElement('canvas');
      }

      bgVideo.srcObject = bgStream;
      await bgVideo.play();

      bgSendTimer = setInterval(() => {
        if (!bgVideo.videoWidth) return;
        bgCanvas.width = bgVideo.videoWidth || 640;
        bgCanvas.height = bgVideo.videoHeight || 480;
        const ctx = bgCanvas.getContext('2d');
        ctx.drawImage(bgVideo, 0, 0, bgCanvas.width, bgCanvas.height);
        const frame = bgCanvas.toDataURL('image/jpeg', 0.8);

        fetch(`${API_URL}/camera/frame`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ imagemBase64: frame })
        }).catch(() => {});
      }, 220);
    } catch (_e) {}
  }

  setInterval(async () => {
    // Se o próprio modal do PC já estiver com a câmera aberta, não precisa do relay em background
    if (state.cameraStream) {
      stopBgRelay();
      return;
    }

    try {
      const res = await fetch(`${API_URL}/camera/status`);
      const status = await res.json();
      if (status.solicitada && (!status.tem_frame_recente || bgStream)) {
        await startBgRelay();
      } else if (!status.solicitada && bgStream) {
        await stopBgRelay();
      }
    } catch (_e) {}
  }, 1500);
}

/* =========================================================
   INICIALIZAÇÃO GERAL
========================================================= */

async function init() {
  initSplash();
  initTheme();
  bindEvents();
  updateAuthUI();
  initServerCameraRelayBridge();

  if (state.usuario?.id && state.token) {
    await carregarDashboard();
  }

  await carregarMateriais();
}

init();
