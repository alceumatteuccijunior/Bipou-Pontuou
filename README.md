# Bipou, Pontuou — Lixeira Inteligente & Gamificação Escolar

Sistema completo de reciclagem escolar integrado à **Lixeira Inteligente com IA (ChatGPT Vision) e microcontrolador ESP32**.

---

## 🚀 Como Funciona o Sistema

1. **Acesso Simplificado por CPF (Sem Senha):**
   - O aluno informa apenas seu CPF (11 dígitos).
   - Se o CPF já existir no banco, o login é imediato sem pedir senha.
   - Se for o primeiro acesso, o sistema cadastra automaticamente uma nova conta e senha interna segura e entra na hora.

2. **Fluxo do Descarte na Lixeira Inteligente:**
   - O aluno clica em **"Depositar lixo"**.
   - O sistema orienta o passo a passo: *"Deposite seu lixo na lixeira, um tipo de cada vez (Papel, Metal ou Plástico)"*.
   - A câmera ao vivo enquadra o material.
   - O aluno clica em **"Feito! Tirar foto e descartar"**.
   - A API processa a imagem com o **ChatGPT Vision (`gpt-4o-mini`)**:
     - Identifica a categoria: `Plastico`, `Papel` ou `Metal`.
     - Aciona o **ESP32** na rota `${ESP32_IP}/descartar?material=...` para mover os servo-motores/compartimentos da lixeira física.
     - Credita **+50 pontos** automaticamente na carteira do aluno.

3. **Troca de Pontos por Balas (40 pontos cada):**
   - Cada bala custa **40 pontos**.
   - O aluno clica em **"Trocar meus pontos por balas"**, escolhe a quantidade desejada e confirma.
   - O sistema gera na hora o **Comprovante Digital Oficial de Retirada** com código único (ex: `#BALA-XXXX-XXXX`), nome, CPF mascarado, quantidade e status `🟢 Válido para troca`.
   - O aluno apresenta o comprovante ao professor ou responsável para retirar as balas.
   - O comprovante pode ser consultado a qualquer momento no **Histórico de Movimentações**.

---

## 📁 Estrutura de Arquivos

```text
Bipou, Pontuou/
├── backend/
│   ├── uploads/            # Fotos dos descartes armazenadas
│   ├── .env                # Credenciais (MySQL, OpenAI API Key, IP do ESP32)
│   ├── .env.example        # Modelo de variáveis de ambiente
│   ├── db.js               # Conexão Pool com MySQL2
│   ├── package.json        # Dependências (Express, OpenAI, MySQL2, Multer, Cors, Dotenv)
│   ├── schema.sql          # Modelagem completa do banco de dados bipa_pesa
│   └── server.js           # API unificada (Auth CPF, Triagem IA, ESP32, Balas e Comprovantes)
├── frontend/
│   ├── 404.html            # Página de erro
│   ├── index.html          # Interface do aluno (Login CPF, Câmera, Balas, Comprovante)
│   ├── robologo.png        # Logo oficial
│   ├── robozinho.png       # Mascote e Favicon
│   ├── script.js           # Lógica do app, webcam, chamada à IA e modais
│   └── style.css           # Estilização completa (Light/Dark mode, scanner, ticket voucher)
└── README.md
```

---

## 🛠️ Configuração e Execução

### 1. Banco de Dados MySQL
O banco se chama `bipa_pesa`. Para criar ou recriar as tabelas:
- Abra o arquivo `backend/schema.sql` no MySQL Workbench ou execute via terminal.
- Usuário padrão: `root` | Senha configurável no `.env`.

### 2. Backend
No terminal, dentro da pasta `backend`:
```bash
npm install
node server.js
```

O arquivo `backend/.env` deve conter:
```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=sua_senha_mysql
DB_NAME=bipa_pesa
PORT=3000
OPENAI_API_KEY=sua_chave_openai
ESP32_IP=http://192.168.137.56
```

### 3. Frontend
Abra a pasta `frontend` com a extensão **Live Server** do VS Code ou acesse diretamente `frontend/index.html`.

A API REST roda em:
- Healthcheck: `http://localhost:3000/api/health`
- Triagem IA & ESP32: `POST http://localhost:3000/api/reciclagens/descartar`
- Login CPF: `POST http://localhost:3000/api/auth/cpf`
- Resgate de Balas: `POST http://localhost:3000/api/resgates/balas`
- Consulta de Comprovante: `GET http://localhost:3000/api/comprovante/:codigo`
