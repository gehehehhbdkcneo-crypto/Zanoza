const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const archiver = require('archiver');
const { v4: uuidv4 } = require('uuid');

const app = express();
const port = 3000;

// API Configuration
const API_KEY = "io-v2-eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJvd25lciI6ImI3NTAyMmRmLTZmYjQtNDEzZC1hZDhmLThiNmI0OGExYjA0NSIsImV4cCI6NDkyNDgzOTUzMn0.Els2ChbqMNbHNwGDhtolIVkEvmaV6dIgonKl1RuZyhbNaCEA1Z9EkciXC9ZAQsqTZVeHv56kMr6TJZCGMPzOvg";
const API_URL = "https://api.intelligence.io.solutions/api/v1";

app.use(express.json({ limit: '50mb' }));
app.use(fileUpload({ limits: { fileSize: 50 * 1024 * 1024 } }));
app.use(express.static(__dirname));

const WORKSPACE = path.join(__dirname, 'workspace');
if (!fs.existsSync(WORKSPACE)) fs.mkdirSync(WORKSPACE);

// Хранилище моделей
let availableModels = [];
let visionModels = [];

// Загрузка моделей при старте
async function loadModels() {
    try {
        console.log('🔄 Загрузка моделей из io.nет...');
        
        const response = await fetch(`${API_URL}/models`, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        const allModels = data.data || data.models || [];
        
        // Разделяем на обычные и vision модели
        availableModels = allModels.filter(m => !m.id?.includes('vision') && !m.id?.includes('Vision'));
        visionModels = allModels.filter(m => m.id?.includes('vision') || m.id?.includes('Vision'));
        
        console.log(`✅ Загружено моделей: ${availableModels.length} обычных, ${visionModels.length} vision`);
        console.log('📝 Топ обычных:');
        availableModels.slice(0, 3).forEach(model => {
            console.log(`   - ${model.id || model.name}`);
        });
        console.log('👁️ Vision модели:');
        visionModels.slice(0, 3).forEach(model => {
            console.log(`   - ${model.id || model.name}`);
        });
        
    } catch (error) {
        console.error('❌ Ошибка загрузки моделей:', error.message);
        // Fallback
        availableModels = [
            { id: 'deepseek/deepseek-v3', name: 'DeepSeek V3' },
            { id: 'qwen/qwen-coder-480b', name: 'Qwen Coder 480B' },
            { id: 'meta-llama/llama-3.3-70b', name: 'Llama 3.3 70B' }
        ];
        visionModels = [
            { id: 'meta-llama/Llama-3.2-90B-Vision-Instruct', name: 'Llama Vision 90B' }
        ];
        console.log('⚠️ Используются fallback модели');
    }
}

function getSessionDir(sessionId) {
    const dir = path.join(WORKSPACE, sessionId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// API: Получить список моделей
app.get('/models', (req, res) => {
    res.json({ 
        models: availableModels,
        visionModels: visionModels
    });
});

// API: Upload file
app.post('/upload', (req, res) => {
    const sessionId = req.body.sessionId || uuidv4();
    const dir = getSessionDir(sessionId);

    if (!req.files || !req.files.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    const file = req.files.file;
    const savePath = path.join(dir, file.name);
    file.mv(savePath, (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'File uploaded', sessionId, filename: file.name });
    });
});

// API: List files
app.get('/files/:sessionId', (req, res) => {
    const dir = getSessionDir(req.params.sessionId);
    if (!fs.existsSync(dir)) {
        return res.json([]);
    }
    const files = fs.readdirSync(dir).map(f => ({
        name: f,
        size: fs.statSync(path.join(dir, f)).size
    }));
    res.json(files);
});

// API: Delete file
app.delete('/files/:sessionId/:filename', (req, res) => {
    const dir = getSessionDir(req.params.sessionId);
    const filePath = path.join(dir, req.params.filename);
    
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        res.json({ message: 'File deleted' });
    } else {
        res.status(404).json({ error: 'File not found' });
    }
});

// API: Run Python
app.post('/run-python', (req, res) => {
    const { sessionId, filename } = req.body;
    const dir = getSessionDir(sessionId);
    const filePath = path.join(dir, filename);

    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'File not found' });
    }

    exec(`python "${filePath}"`, { 
        timeout: 30000,
        cwd: dir 
    }, (error, stdout, stderr) => {
        if (error) {
            return res.json({ 
                error: stderr || error.message,
                output: stdout 
            });
        }
        res.json({ output: stdout });
    });
});

// API: Download ZIP
app.get('/download-zip/:sessionId', (req, res) => {
    const dir = getSessionDir(req.params.sessionId);
    
    if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
        return res.status(404).json({ error: 'No files to download' });
    }
    
    const zipPath = path.join(WORKSPACE, req.params.sessionId + '.zip');

    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });

    output.on('close', () => {
        res.download(zipPath, 'workspace.zip', (err) => {
            fs.unlinkSync(zipPath);
        });
    });
    
    archive.on('error', (err) => {
        res.status(500).json({ error: err.message });
    });

    archive.pipe(output);
    archive.directory(dir, false);
    archive.finalize();
});

// API: Chat с streaming
app.post('/chat', async (req, res) => {
    const { message, model, sessionId, images } = req.body;
    
    // SSE заголовки
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Отключаем буферизацию nginx

    try {
        const dir = getSessionDir(sessionId);
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        
        // Системный промпт
        const systemPrompt = `Ты — AI ассистент в локальном веб-приложении на io.nет.

**Твои возможности:**
- Создавать файлы (код, текст, данные)
- Читать загруженные файлы
- Запускать Python скрипты
- Работать с файлами пользователя
- Анализировать изображения (если отправлены)

**Текущая сессия:**
- Рабочая директория: ${dir}
- Файлы: ${files.length > 0 ? files.join(', ') : 'нет'}

**ВАЖНО:**
1. НЕ предлагай создать ZIP без явного запроса
2. Будь лаконичен
3. Пиши на русском
4. Используй markdown для кода`;

        // Определяем модель (используем vision если есть картинки)
        let selectedModel = model;
        if (images && images.length > 0 && !selectedModel?.includes('vision') && !selectedModel?.includes('Vision')) {
            // Переключаемся на vision модель
            selectedModel = visionModels[0]?.id || 'meta-llama/Llama-3.2-90B-Vision-Instruct';
            console.log(`🖼️ Картинка обнаружена, переключение на vision: ${selectedModel}`);
        }
        
        if (!selectedModel) {
            selectedModel = availableModels[0]?.id || 'deepseek/deepseek-v3';
        }
        
        console.log(`💬 Запрос к модели: ${selectedModel}`);

        // Формируем content для user сообщения
        let userContent;
        if (images && images.length > 0) {
            // Для vision моделей - массив с текстом и картинками
            userContent = [
                { type: 'text', text: message }
            ];
            
            // Добавляем все картинки
            images.forEach(img => {
                userContent.push({
                    type: 'image_url',
                    image_url: {
                        url: img // Формат: data:image/jpeg;base64,{base64}
                    }
                });
            });
        } else {
            // Для обычных моделей - просто текст
            userContent = message;
        }

        // Запрос к io.nет API
        const response = await fetch(`${API_URL}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${API_KEY}`
            },
            body: JSON.stringify({
                model: selectedModel,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userContent }
                ],
                stream: true,
                temperature: 0.7
            })
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`API error: ${response.status} ${errorText}`);
        }

        // Читаем stream БЕЗ БУФЕРИЗАЦИИ
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            // Декодируем и сразу отправляем
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            
            // Оставляем последнюю неполную строку в буфере
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(data);
                        
                        // io.nет использует OpenAI формат
                        const text = parsed.choices?.[0]?.delta?.content || '';
                        if (text) {
                            // Отправляем СРАЗУ без задержки
                            res.write(`data: ${JSON.stringify({ text })}\n\n`);
                        }
                    } catch (e) {
                        // Игнорируем ошибки парсинга
                    }
                }
            }
        }

        res.write('data: [DONE]\n\n');
        res.end();

    } catch (error) {
        console.error('❌ Chat error:', error);
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.end();
    }
});

// Главная страница
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Старт сервера
app.listen(port, async () => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('🔥 Zanoza AI Chat v2.0');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`🌐 Server: http://localhost:${port}`);
    console.log(`📁 Workspace: ${WORKSPACE}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    await loadModels();
    
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('✅ Сервер запущен!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
