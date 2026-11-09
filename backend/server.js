const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const readline = require('readline');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { OpenAI } = require('openai');
const { pool, testarConexao } = require('./db');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ESP32_IP = process.env.ESP32_IP || 'http://192.168.137.56';

/* =========================================================
   GERENCIADOR DE TRANSMISSÃO E CAPTURA DA CÂMERA DA LIXEIRA
   Permite que celulares na rede vejam e disparem a câmera USB fixa no PC
========================================================= */

let ultimoFrameLixeira = null;
let ultimoFrameBuffer = null;
let ultimoFrameTimestamp = 0;
let cameraSolicitadaAte = 0;
let cameraStreamProc = null;
let cameraInactivityTimer = null;
const mjpegClients = new Set();
const frameWaiters = new Set();

function atualizarFrameLixeira(dataUrl) {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return;
  const commaIdx = dataUrl.indexOf(',');
  if (commaIdx === -1) return;

  const base64Data = dataUrl.slice(commaIdx + 1);
  const buffer = Buffer.from(base64Data, 'base64');
  if (!buffer.length) return;

  ultimoFrameLixeira = dataUrl;
  ultimoFrameBuffer = buffer;
  ultimoFrameTimestamp = Date.now();

  // Notifica promessas que aguardam um quadro novo
  for (const waiter of frameWaiters) {
    waiter(dataUrl);
  }
  frameWaiters.clear();

  // Transmite via MJPEG para todos os celulares/navegadores conectados
  if (mjpegClients.size > 0) {
    const header = `--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${buffer.length}\r\n\r\n`;
    for (const clientRes of mjpegClients) {
      try {
        clientRes.write(header);
        clientRes.write(buffer);
        clientRes.write('\r\n');
      } catch (_e) {
        mjpegClients.delete(clientRes);
      }
    }
  }
}

function agendarParadaCameraInativa() {
  if (cameraInactivityTimer) clearTimeout(cameraInactivityTimer);
  cameraInactivityTimer = setTimeout(() => {
    if (mjpegClients.size === 0 && cameraStreamProc) {
      try {
        cameraStreamProc.kill();
      } catch (_e) {}
      cameraStreamProc = null;
    }
  }, 15000);
}

function iniciarStreamCameraLixeira(indice) {
  cameraSolicitadaAte = Date.now() + 18000;
  agendarParadaCameraInativa();
  if (cameraStreamProc) return;

  const scriptPath = path.join(__dirname, 'camera.py');
  const camIdx = String(indice ?? (process.env.WEBCAM_INDEX || 0));

  try {
    const proc = spawn('python', [scriptPath, camIdx, '--stream'], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    cameraStreamProc = proc;

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('data:image/')) {
        atualizarFrameLixeira(trimmed);
      }
    });

    proc.stderr.on('data', (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) console.warn('⚠️ [camera.py]:', msg);
    });

    proc.on('close', () => {
      if (cameraStreamProc === proc) {
        cameraStreamProc = null;
      }
    });
  } catch (err) {
    console.error('Erro ao iniciar processo de stream da câmera:', err.message);
    cameraStreamProc = null;
  }
}

// Função para capturar foto diretamente da câmera física USB ligada ao computador
function capturarFotoDaLixeira(indice) {
  // Se já temos um frame recente (< 3.5s) do stream ou relay da lixeira, usa na hora!
  if (ultimoFrameLixeira && Date.now() - ultimoFrameTimestamp < 3500) {
    return Promise.resolve(ultimoFrameLixeira);
  }

  return new Promise((resolve, reject) => {
    iniciarStreamCameraLixeira(indice);

    let finalizado = false;
    const waiter = (frame) => {
      if (finalizado) return;
      finalizado = true;
      clearTimeout(timer);
      resolve(frame);
    };

    frameWaiters.add(waiter);

    const timer = setTimeout(() => {
      frameWaiters.delete(waiter);
      if (finalizado) return;
      finalizado = true;

      // Fallback para captura avulsa caso o stream não tenha entregado a tempo
      const scriptPath = path.join(__dirname, 'camera.py');
      const camIdx = String(indice ?? (process.env.WEBCAM_INDEX || 0));

      execFile('python', [scriptPath, camIdx], { maxBuffer: 25 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          console.error('Erro no script de captura:', stderr || error.message);
          return reject(new Error('Não foi possível capturar imagem da câmera conectada à lixeira.'));
        }
        const output = stdout.trim();
        if (!output.startsWith('data:image/')) {
          return reject(new Error('A câmera da lixeira não retornou uma imagem válida.'));
        }
        atualizarFrameLixeira(output);
        resolve(output);
      });
    }, 4500);
  });
}

// Inicializa a OpenAI para visão computacional do lixo
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || 'dummy_key'
});

// Diretório de uploads e frontend
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const frontendDir = path.join(__dirname, '..', 'frontend');

app.use(cors());
// Limite aumentado para permitir fotos capturadas da webcam em alta definição
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));
app.use('/uploads', express.static(uploadsDir));
// Serve o frontend diretamente pela porta 3000
app.use(express.static(frontendDir));

// Configuração do multer para arquivos avulsos
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const nome = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
    cb(null, nome);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const permitidos = ['image/jpeg', 'image/png', 'image/webp'];
    if (!permitidos.includes(file.mimetype)) {
      return cb(new Error('Envie apenas JPG, PNG ou WEBP.'));
    }
    cb(null, true);
  }
});

/* =========================================================
   UTILITÁRIOS
========================================================= */

function normalizarCPF(valor = '') {
  return String(valor).replace(/\D/g, '').slice(0, 11);
}

function formatarCPF(cpf = '') {
  const digits = normalizarCPF(cpf);
  if (digits.length === 11) {
    return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
  }
  return digits;
}

function mascararCPF(cpf = '') {
  const digits = normalizarCPF(cpf);
  if (digits.length === 11) {
    return `***.${digits.slice(3, 6)}.${digits.slice(6, 9)}-**`;
  }
  return digits;
}

function validarCPF(cpf) {
  const limpo = normalizarCPF(cpf);
  return limpo.length === 11;
}

function gerarCodigoComprovante() {
  const aleatorio = crypto.randomBytes(2).toString('hex').toUpperCase();
  const timestamp = Date.now().toString(36).toUpperCase().slice(-4);
  return `BALA-${timestamp}-${aleatorio}`;
}

function enviarErro(res, status, mensagem) {
  return res.status(status).json({ sucesso: false, erro: mensagem, mensagem });
}

// Salva imagem base64 no disco e retorna o caminho relativo
function salvarBase64NoDisco(imagemBase64) {
  try {
    const matches = imagemBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    if (!matches || matches.length !== 3) {
      return null;
    }
    const buffer = Buffer.from(matches[2], 'base64');
    const nomeArquivo = `descarte-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.jpg`;
    const caminhoCompleto = path.join(uploadsDir, nomeArquivo);
    fs.writeFileSync(caminhoCompleto, buffer);
    return `/uploads/${nomeArquivo}`;
  } catch (err) {
    console.error('Erro ao salvar imagem base64:', err.message);
    return null;
  }
}

/* =========================================================
   ENDPOINTS
========================================================= */

// Healthcheck
app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      sucesso: true,
      mensagem: 'Bipou, Pontuou API online.',
      esp32_ip: ESP32_IP,
      openai_configurada: Boolean(process.env.OPENAI_API_KEY)
    });
  } catch (error) {
    res.status(500).json({ sucesso: false, mensagem: 'API online, mas banco indisponível.' });
  }
});

/*
  Login / Cadastro automático por CPF:
  - O aluno digita apenas o CPF (sem login/senha manual).
  - Se o CPF já existe no banco: loga diretamente sem senha.
  - Se não existe: gera uma senha automática no banco, cria o cadastro e loga na hora.
*/
app.post(['/api/auth', '/api/auth/cpf'], async (req, res) => {
  try {
    const cpf = normalizarCPF(req.body.cpf || req.body.telefone);
    let nome = String(req.body.nome || '').trim();

    if (!validarCPF(cpf)) {
      return enviarErro(res, 400, 'Informe um CPF válido com 11 dígitos.');
    }

    const [existentes] = await pool.execute(
      'SELECT id, nome, cpf, pontos, criado_em FROM usuarios WHERE cpf = ? LIMIT 1',
      [cpf]
    );

    let usuario;
    let novoUsuario = false;

    if (existentes.length > 0) {
      usuario = existentes[0];
      // Se enviou um nome diferente do que estava registrado, atualiza
      if (nome && nome.length >= 2 && usuario.nome !== nome) {
        await pool.execute('UPDATE usuarios SET nome = ? WHERE id = ?', [nome, usuario.id]);
        usuario.nome = nome;
      }
    } else {
      novoUsuario = true;
      if (!nome || nome.length < 2) {
        nome = `Aluno Eco (${cpf.slice(-4)})`;
      }
      // Gera uma senha automática no banco para o novo usuário
      const senhaAutomatica = crypto.randomBytes(16).toString('hex');

      const [resultado] = await pool.execute(
        'INSERT INTO usuarios (cpf, nome, senha, pontos) VALUES (?, ?, ?, 0)',
        [cpf, nome, senhaAutomatica]
      );

      usuario = {
        id: resultado.insertId,
        nome,
        cpf,
        pontos: 0,
        criado_em: new Date()
      };
    }

    const token = crypto.randomBytes(24).toString('hex');

    res.json({
      sucesso: true,
      token,
      novo: novoUsuario,
      mensagem: novoUsuario ? 'Cadastro realizado com sucesso!' : 'Bem-vindo de volta!',
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        cpf: formatarCPF(usuario.cpf),
        cpf_mascarado: mascararCPF(usuario.cpf),
        pontos: usuario.pontos
      }
    });
  } catch (error) {
    console.error('Erro na autenticação:', error);
    enviarErro(res, 500, 'Erro ao realizar login/cadastro.');
  }
});

// Dados do usuário
app.get('/api/usuarios/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return enviarErro(res, 400, 'Usuário inválido.');

    const [rows] = await pool.execute(
      'SELECT id, nome, cpf, pontos, criado_em FROM usuarios WHERE id = ? LIMIT 1',
      [id]
    );

    if (!rows.length) return enviarErro(res, 404, 'Usuário não encontrado.');

    const u = rows[0];
    res.json({
      sucesso: true,
      usuario: {
        id: u.id,
        nome: u.nome,
        cpf: formatarCPF(u.cpf),
        cpf_mascarado: mascararCPF(u.cpf),
        pontos: u.pontos,
        criado_em: u.criado_em
      }
    });
  } catch (error) {
    console.error(error);
    enviarErro(res, 500, 'Erro ao buscar usuário.');
  }
});

// Dashboard agregado para a interface do aluno
app.get('/api/dashboard/:usuarioId', async (req, res) => {
  try {
    const usuarioId = Number(req.params.usuarioId);
    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      return enviarErro(res, 400, 'Usuário inválido.');
    }

    const [usuarios] = await pool.execute(
      'SELECT id, nome, cpf, pontos, criado_em FROM usuarios WHERE id = ? LIMIT 1',
      [usuarioId]
    );

    if (!usuarios.length) return enviarErro(res, 404, 'Usuário não encontrado.');
    const usuario = usuarios[0];

    // Histórico de reciclagens recentes
    const [reciclagens] = await pool.execute(`
      SELECT
        id,
        material,
        confianca,
        descricao_ia,
        status_esp32,
        pontos_ganhos,
        foto_url,
        UNIX_TIMESTAMP(criado_em) AS timestamp,
        DATE_FORMAT(criado_em, '%d/%m/%Y %H:%i') AS data
      FROM reciclagens
      WHERE usuario_id = ?
      ORDER BY criado_em DESC
      LIMIT 15
    `, [usuarioId]);

    // Histórico de resgates e comprovantes
    const [resgates] = await pool.execute(`
      SELECT
        rs.id,
        rs.codigo_comprovante,
        rs.quantidade,
        rs.pontos_gastos,
        rs.status,
        rp.titulo,
        UNIX_TIMESTAMP(rs.criado_em) AS timestamp,
        DATE_FORMAT(rs.criado_em, '%d/%m/%Y %H:%i') AS data
      FROM resgates rs
      INNER JOIN recompensas rp ON rp.id = rs.recompensa_id
      WHERE rs.usuario_id = ?
      ORDER BY rs.criado_em DESC
      LIMIT 15
    `, [usuarioId]);

    // Top 10 Ranking
    const [ranking] = await pool.execute(`
      SELECT
        posicao,
        id,
        nome,
        pontos
      FROM (
        SELECT
          ROW_NUMBER() OVER (ORDER BY pontos DESC, id ASC) AS posicao,
          id,
          nome,
          pontos
        FROM usuarios
      ) ranked
      ORDER BY posicao ASC
      LIMIT 10
    `);

    // Catálogo de Recompensas
    const [recompensas] = await pool.execute(`
      SELECT id, titulo, pontos_necessarios, estoque
      FROM recompensas
      ORDER BY pontos_necessarios ASC
    `);

    res.json({
      sucesso: true,
      usuario: {
        id: usuario.id,
        nome: usuario.nome,
        cpf: formatarCPF(usuario.cpf),
        cpf_mascarado: mascararCPF(usuario.cpf),
        pontos: usuario.pontos
      },
      reciclagens,
      resgates,
      ranking,
      recompensas
    });
  } catch (error) {
    console.error('Erro no dashboard:', error);
    enviarErro(res, 500, 'Erro ao carregar o painel.');
  }
});

// Ranking geral
app.get('/api/ranking', async (_req, res) => {
  try {
    const [ranking] = await pool.execute(`
      SELECT
        posicao,
        id,
        nome,
        pontos
      FROM (
        SELECT
          ROW_NUMBER() OVER (ORDER BY pontos DESC, id ASC) AS posicao,
          id,
          nome,
          pontos
        FROM usuarios
      ) ranked
      ORDER BY posicao ASC
    `);

    res.json({ sucesso: true, ranking });
  } catch (error) {
    console.error(error);
    enviarErro(res, 500, 'Erro ao carregar ranking.');
  }
});

// Materiais suportados
app.get('/api/materiais', async (_req, res) => {
  try {
    const [materiais] = await pool.execute(
      'SELECT id, nome, pontos_por_descarte FROM materiais ORDER BY nome'
    );
    res.json({ sucesso: true, materiais });
  } catch (error) {
    console.error(error);
    enviarErro(res, 500, 'Erro ao carregar materiais.');
  }
});

// Stream MJPEG em tempo real da câmera fixa da lixeira para celulares e computadores na rede
app.get('/api/camera/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=frame',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });

  mjpegClients.add(res);
  iniciarStreamCameraLixeira(req.query.index);

  // Se já houver um frame em memória, envia imediatamente para abrir o visor na hora
  if (ultimoFrameBuffer) {
    try {
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${ultimoFrameBuffer.length}\r\n\r\n`);
      res.write(ultimoFrameBuffer);
      res.write('\r\n');
    } catch (_e) {}
  }

  req.on('close', () => {
    mjpegClients.delete(res);
    agendarParadaCameraInativa();
  });
});

// Endpoint para obter prévia rápida da câmera fixa da lixeira
app.get('/api/camera/preview', async (req, res) => {
  try {
    const fotoBase64 = await capturarFotoDaLixeira(req.query.index);
    res.json({ sucesso: true, imagemBase64: fotoBase64, timestamp: ultimoFrameTimestamp });
  } catch (err) {
    res.status(500).json({ sucesso: false, erro: err.message });
  }
});

// Relay opcional: permite que o navegador aberto no PC servidor alimente o buffer da câmera da lixeira
app.post('/api/camera/frame', (req, res) => {
  const { imagemBase64 } = req.body || {};
  if (!imagemBase64) {
    return res.status(400).json({ sucesso: false, erro: 'Frame ausente.' });
  }
  atualizarFrameLixeira(imagemBase64);
  res.json({ sucesso: true });
});

// Status da câmera da lixeira (para sincronização automática entre PC servidor e celulares na rede)
app.get('/api/camera/status', (_req, res) => {
  const agora = Date.now();
  res.json({
    sucesso: true,
    solicitada: mjpegClients.size > 0 || agora < cameraSolicitadaAte,
    clientes_conectados: mjpegClients.size,
    tem_frame_recente: Boolean(ultimoFrameLixeira && agora - ultimoFrameTimestamp < 3000),
    ultimo_frame_ms: ultimoFrameTimestamp ? agora - ultimoFrameTimestamp : null
  });
});

/* =========================================================
   FLUXO DA LIXEIRA INTELIGENTE (OPENAI VISION + ESP32 + 50 PTS)
   Compatível com a API original e integrado ao sistema de pontos
========================================================= */

app.post(['/api/classificar', '/api/reciclagens/descartar'], async (req, res) => {
  try {
    let { imagemBase64, usuario_id, usarCameraLixeira, cameraIndex } = req.body;

    // Se não enviou imagem ou solicitou usar a câmera física da lixeira (ligada no PC):
    if (!imagemBase64 || usarCameraLixeira) {
      console.log('📸 Disparando foto direto na câmera USB fixa na lixeira (servidor)...');
      try {
        imagemBase64 = await capturarFotoDaLixeira(cameraIndex);
        console.log('✅ Foto capturada com sucesso pela câmera fixa da lixeira!');
      } catch (camErr) {
        return res.status(500).json({
          sucesso: false,
          erro: camErr.message,
          mensagem: 'Falha ao acionar a câmera fixa conectada à lixeira.'
        });
      }
    }

    console.log('🤖 Imagem pronta. Enviando para o ChatGPT Vision...');

    // Chamada à IA GPT-4o-mini
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Você é um sistema de triagem industrial de lixo reciclável. 
Analise a imagem e identifique o material principal entre as categorias: "Plastico", "Papel", "Metal".
Se não houver objeto claro ou for outro material, responda "Desconhecido".
Responda APENAS em JSON no seguinte formato:
{"material": "Plastico" | "Papel" | "Metal" | "Desconhecido", "confianca": "alta" | "media" | "baixa", "descricao": "breve explicação"}`
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Classifique o material presente nesta foto sob demanda:' },
            {
              type: 'image_url',
              image_url: {
                url: imagemBase64
              }
            }
          ]
        }
      ],
      response_format: { type: 'json_object' }
    });

    const resultado = JSON.parse(response.choices[0].message.content);
    console.log('🤖 Resultado da IA:', resultado);

    let esp32Status = 'Não acionado';
    const materialValido = ['Papel', 'Metal', 'Plastico'].includes(resultado.material);

    // Salva a foto para histórico do usuário
    const fotoUrl = salvarBase64NoDisco(imagemBase64);

    // Se o material for reconhecido, dispara a chamada para o ESP32 da lixeira inteligente
    if (materialValido) {
      const urlESP = `${ESP32_IP}/descartar?material=${resultado.material.toLowerCase()}`;
      console.log(`📡 Enviando comando ao ESP32: ${urlESP}`);

      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const espResponse = await fetch(urlESP, { signal: controller.signal });
        clearTimeout(timeoutId);
        const espText = await espResponse.text();
        console.log(`✅ Resposta do ESP32: ${espText}`);
        esp32Status = `Sucesso: ${espText}`;
      } catch (espError) {
        console.error('⚠️ Erro de comunicação com o ESP32:', espError.message);
        esp32Status = `ESP32 offline no momento (${espError.message}), descarte registrado.`;
      }
    } else {
      console.log('ℹ️ Material desconhecido ou não identificado.');
    }

    // Se houver um usuário associado ao descarte e o material for válido, credita 50 PONTOS!
    let pontosGanhos = 0;
    let novoSaldo = null;

    if (materialValido && usuario_id) {
      const uId = Number(usuario_id);
      if (Number.isInteger(uId) && uId > 0) {
        const conn = await pool.getConnection();
        try {
          await conn.beginTransaction();

          const [uRows] = await conn.execute(
            'SELECT id, pontos FROM usuarios WHERE id = ? FOR UPDATE',
            [uId]
          );

          if (uRows.length > 0) {
            pontosGanhos = 50;

            await conn.execute(
              'UPDATE usuarios SET pontos = pontos + ? WHERE id = ?',
              [pontosGanhos, uId]
            );

            await conn.execute(`
              INSERT INTO reciclagens
                (usuario_id, material, confianca, descricao_ia, status_esp32, pontos_ganhos, foto_url)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `, [
              uId,
              resultado.material,
              resultado.confianca || 'alta',
              resultado.descricao || '',
              esp32Status,
              pontosGanhos,
              fotoUrl
            ]);

            novoSaldo = uRows[0].pontos + pontosGanhos;
            await conn.commit();
            console.log(`🎉 50 pontos creditados com sucesso para o usuário ID ${uId}. Novo saldo: ${novoSaldo}`);
          } else {
            await conn.rollback();
          }
        } catch (dbErr) {
          await conn.rollback();
          console.error('Erro ao creditar pontos no banco:', dbErr);
        } finally {
          conn.release();
        }
      }
    }

    // Retorna resposta unificada compatível com o frontend e com a lixeira-api original
    return res.json({
      sucesso: materialValido,
      material: resultado.material,
      confianca: resultado.confianca,
      descricao: resultado.descricao,
      esp32Status,
      pontos_ganhos: pontosGanhos,
      saldo_atual: novoSaldo,
      foto_url: fotoUrl,
      imagemBase64,
      mensagem: materialValido
        ? `Descarte de ${resultado.material} confirmado! Você ganhou 50 pontos!`
        : 'Não foi possível identificar Plástico, Papel ou Metal. Verifique o enquadramento e tente novamente.'
    });

  } catch (error) {
    console.error('❌ Falha na triagem:', error);
    return res.status(500).json({
      sucesso: false,
      erro: 'Falha ao analisar a imagem com IA.',
      mensagem: error.message
    });
  }
});

/* =========================================================
   RESGATE DE PONTOS POR BALAS (40 PONTOS POR BALA + COMPROVANTE)
========================================================= */

app.post(['/api/resgates', '/api/resgates/balas'], async (req, res) => {
  const connection = await pool.getConnection();

  try {
    const usuarioId = Number(req.body.usuario_id);
    const recompensaId = req.body.recompensa_id ? Number(req.body.recompensa_id) : null;
    const quantidade = Math.max(1, Number(req.body.quantidade || 1));

    if (!Number.isInteger(usuarioId) || usuarioId <= 0) {
      return enviarErro(res, 400, 'Usuário inválido.');
    }

    await connection.beginTransaction();

    const [usuarios] = await connection.execute(
      'SELECT id, nome, cpf, pontos FROM usuarios WHERE id = ? FOR UPDATE',
      [usuarioId]
    );

    if (!usuarios.length) {
      await connection.rollback();
      return enviarErro(res, 404, 'Usuário não encontrado.');
    }

    let recompensas = [];
    if (recompensaId && Number.isInteger(recompensaId) && recompensaId > 0) {
      [recompensas] = await connection.execute(
        'SELECT id, titulo, pontos_necessarios, estoque FROM recompensas WHERE id = ? LIMIT 1 FOR UPDATE',
        [recompensaId]
      );
    }

    // Busca a recompensa de Bala por padrão (ou cria se não existir)
    if (!recompensas.length) {
      [recompensas] = await connection.execute(
        'SELECT id, titulo, pontos_necessarios, estoque FROM recompensas WHERE titulo = ? LIMIT 1 FOR UPDATE',
        ['Bala']
      );
    }

    if (!recompensas.length) {
      await connection.execute(
        'INSERT INTO recompensas (titulo, pontos_necessarios, estoque) VALUES ("Bala", 40, 1000)'
      );
      [recompensas] = await connection.execute(
        'SELECT id, titulo, pontos_necessarios, estoque FROM recompensas WHERE titulo = ? LIMIT 1 FOR UPDATE',
        ['Bala']
      );
    }

    const usuario = usuarios[0];
    const recompensa = recompensas[0];
    const pontosUnitario = Number(recompensa.pontos_necessarios || 40);
    const pontosTotalNecessarios = pontosUnitario * quantidade;

    if (recompensa.estoque < quantidade) {
      await connection.rollback();
      return enviarErro(res, 409, `Estoque insuficiente de balas. Temos apenas ${recompensa.estoque} disponíveis.`);
    }

    if (usuario.pontos < pontosTotalNecessarios) {
      await connection.rollback();
      return enviarErro(
        res,
        409,
        `Você precisa de ${pontosTotalNecessarios} pontos para retirar ${quantidade} bala(s). Seu saldo atual é ${usuario.pontos} pontos.`
      );
    }

    // Deduz pontos e estoque
    await connection.execute(
      'UPDATE usuarios SET pontos = pontos - ? WHERE id = ?',
      [pontosTotalNecessarios, usuarioId]
    );

    await connection.execute(
      'UPDATE recompensas SET estoque = estoque - ? WHERE id = ?',
      [quantidade, recompensa.id]
    );

    // Gera código único para o comprovante
    const codigoComprovante = gerarCodigoComprovante();

    await connection.execute(`
      INSERT INTO resgates
        (codigo_comprovante, usuario_id, recompensa_id, quantidade, pontos_gastos, status)
      VALUES (?, ?, ?, ?, ?, 'Válido para troca')
    `, [codigoComprovante, usuarioId, recompensa.id, quantidade, pontosTotalNecessarios]);

    await connection.commit();

    const dataAtual = new Date();
    const dataFormatada = dataAtual.toLocaleDateString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });

    res.status(201).json({
      sucesso: true,
      mensagem: `Resgate de ${quantidade} bala(s) realizado com sucesso! Mostre seu comprovante.`,
      pontos_restantes: usuario.pontos - pontosTotalNecessarios,
      comprovante: {
        codigo: codigoComprovante,
        usuario_nome: usuario.nome,
        usuario_cpf: formatarCPF(usuario.cpf),
        usuario_cpf_mascarado: mascararCPF(usuario.cpf),
        recompensa: recompensa.titulo,
        quantidade,
        pontos_gastos: pontosTotalNecessarios,
        data: dataFormatada,
        status: 'Válido para troca'
      }
    });

  } catch (error) {
    await connection.rollback();
    console.error('Erro no resgate de balas:', error);
    enviarErro(res, 500, 'Erro ao processar o resgate de balas.');
  } finally {
    connection.release();
  }
});

// Consulta de Comprovante por código
app.get('/api/comprovante/:codigo', async (req, res) => {
  try {
    const { codigo } = req.params;

    const [rows] = await pool.execute(`
      SELECT
        rs.id,
        rs.codigo_comprovante,
        rs.quantidade,
        rs.pontos_gastos,
        rs.status,
        DATE_FORMAT(rs.criado_em, '%d/%m/%Y %H:%i') AS data,
        u.nome AS usuario_nome,
        u.cpf AS usuario_cpf,
        rp.titulo AS recompensa
      FROM resgates rs
      INNER JOIN usuarios u ON u.id = rs.usuario_id
      INNER JOIN recompensas rp ON rp.id = rs.recompensa_id
      WHERE rs.codigo_comprovante = ?
      LIMIT 1
    `, [codigo]);

    if (!rows.length) {
      return enviarErro(res, 404, 'Comprovante não encontrado.');
    }

    const c = rows[0];
    res.json({
      sucesso: true,
      comprovante: {
        codigo: c.codigo_comprovante,
        usuario_nome: c.usuario_nome,
        usuario_cpf: formatarCPF(c.usuario_cpf),
        usuario_cpf_mascarado: mascararCPF(c.usuario_cpf),
        recompensa: c.recompensa,
        quantidade: c.quantidade,
        pontos_gastos: c.pontos_gastos,
        data: c.data,
        status: c.status
      }
    });
  } catch (error) {
    console.error(error);
    enviarErro(res, 500, 'Erro ao buscar comprovante.');
  }
});

// Upload manual de arquivos
app.post('/api/upload', upload.single('imagem'), async (req, res) => {
  try {
    if (!req.file) return enviarErro(res, 400, 'Nenhuma imagem foi enviada.');

    const url = `/uploads/${req.file.filename}`;
    res.status(201).json({
      sucesso: true,
      mensagem: 'Imagem enviada com sucesso.',
      arquivo: req.file.filename,
      url
    });
  } catch (error) {
    console.error(error);
    enviarErro(res, 500, 'Erro ao enviar imagem.');
  }
});

// Rota SPA: qualquer rota não-API serve o frontend
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
  res.sendFile(path.join(frontendDir, 'index.html'));
});

app.use((_req, res) => {
  res.status(404).json({ sucesso: false, mensagem: 'Rota não encontrada.' });
});

app.use((error, _req, res, _next) => {
  console.error(error);
  if (error instanceof multer.MulterError) {
    return enviarErro(res, 400, 'Erro no upload da imagem.');
  }
  if (error.message) return enviarErro(res, 400, error.message);
  enviarErro(res, 500, 'Erro interno do servidor.');
});

async function iniciar() {
  try {
    await testarConexao();

    const os = require('os');
    const nets = os.networkInterfaces();
    const networkIps = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254')) {
          networkIps.push({ name, ip: net.address });
        }
      }
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log('');
      console.log('========================================================');
      console.log('       Bipou, Pontuou + Lixeira Inteligente (ESP32)');
      console.log('========================================================');
      console.log(`🌐 Acesso Local:      http://localhost:${PORT}`);
      networkIps.forEach(net => {
        console.log(`📱 Acesso na Rede (${net.name}): http://${net.ip}:${PORT}`);
      });
      console.log(`❤️  Healthcheck:        http://localhost:${PORT}/api/health`);
      console.log(`📡 Alvo ESP32:         ${ESP32_IP}`);
      console.log(`🍬 Troca de pontos:    40 pontos por Bala`);
      console.log(`♻️  Pontos por descarte: 50 pontos`);
      console.log('========================================================');
      console.log('');
    });
  } catch (error) {
    console.error('Falha ao iniciar servidor:', error.message);
    process.exit(1);
  }
}

iniciar();
