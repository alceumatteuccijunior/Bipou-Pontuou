require('dotenv').config();
const express = require('express');
const { OpenAI } = require('openai');

const app = express();
const port = process.env.PORT || 3000;

// IP padrão do ESP32 quando em modo Access Point (SoftAP)
const ESP32_IP = process.env.ESP32_IP || 'http://192.168.137.56';

// Inicializa a API da OpenAI
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

// Aumenta o limite de payload para aceitar imagens em Base64
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));
    
// Endpoint que recebe a foto, consulta o ChatGPT Vision e aciona o ESP32
app.post('/api/classificar', async (req, res) => {
    try {
        const { imagemBase64 } = req.body;

        if (!imagemBase64) {
            return res.status(400).json({ erro: 'Nenhuma imagem foi enviada.' });
        }

        console.log('Imagem recebida. A enviar para o ChatGPT Vision...');

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
        console.log('Resultado da IA:', resultado);

        let esp32Status = 'Não acionado';

        // Se o material for reconhecido, dispara a chamada para o ESP32
        if (['Papel', 'Metal', 'Plastico'].includes(resultado.material)) {
            const urlESP = `${ESP32_IP}/descartar?material=${resultado.material.toLowerCase()}`;
            console.log(`Enviando comando ao ESP32: ${urlESP}`);

            try {
                // Utiliza a API nativa fetch (disponível no Node.js 18+)
                const espResponse = await fetch(urlESP);
                const espText = await espResponse.text();
                console.log(`Resposta do ESP32: ${espText}`);
                esp32Status = `Sucesso: ${espText}`;
            } catch (espError) {
                console.error('Erro de comunicação com o ESP32:', espError.message);
                esp32Status = `Falha na comunicação: ${espError.message}`;
            }
        } else {
            console.log('Material desconhecido. Nenhum motor foi acionado.');
        }

        // Retorna o resultado da IA juntamente com o status do acionamento
        return res.json({
            ...resultado,
            esp32Status
        });

    } catch (error) {
        console.error('Erro na API OpenAI:', error);
        return res.status(500).json({ erro: 'Falha ao analisar a imagem.' });
    }
});

app.listen(port, () => {
    console.log(`API de Triagem ativa em http://localhost:${port}`);
    console.log(`Alvo do ESP32 configurado para: ${ESP32_IP}`);
});