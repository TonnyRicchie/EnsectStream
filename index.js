const TelegramBot = require('node-telegram-bot-api');
const stream = require('stream');
const { promisify } = require('util');
const fetch = require('node-fetch');
const FormData = require('form-data');
const https = require('https');
const http = require('http');
const pipeline = promisify(stream.pipeline);

// Servidor HTTP para mantener el servicio activo
const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('Bot is running!');
});
server.listen(process.env.PORT || 3000);

// Configuración mejorada del agente HTTPS
const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    timeout: 60000,
    rejectUnauthorized: false
});

const token = process.env.BOT_TOKEN;

// Configuración mejorada del bot
const bot = new TelegramBot(token, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    },
    request: {
        timeout: 30000,
        agent: httpsAgent,
        proxy: false
    },
    baseApiUrl: "https://api.telegram.org"
});

const sessions = {};
const uploadData = {};
const States = {
    IDLE: 'IDLE',
    AWAITING_ACCESS_KEY: 'AWAITING_ACCESS_KEY',
    AWAITING_SECRET_KEY: 'AWAITING_SECRET_KEY',
    AWAITING_FILE: 'AWAITING_FILE',
    AWAITING_TITLE: 'AWAITING_TITLE',
    AWAITING_DESCRIPTION: 'AWAITING_DESCRIPTION',
    AWAITING_COLLECTION: 'AWAITING_COLLECTION',
    UPLOADING: 'UPLOADING',
    AWAITING_RENAME: 'AWAITING_RENAME',
    EDITING_TITLE: 'EDITING_TITLE',
    EDITING_DESCRIPTION: 'EDITING_DESCRIPTION',
    EDITING_COLLECTION: 'EDITING_COLLECTION',
    ADDING_FILE_TO_EXISTING: 'ADDING_FILE_TO_EXISTING',
    AWAITING_NEW_FILE_URL: 'AWAITING_NEW_FILE_URL',
    AWAITING_NEW_FILE_NAME: 'AWAITING_NEW_FILE_NAME'
};

let userStates = {};
let lastUpdateTime = {};
let isReconnecting = false;

const urlRegex = /^(https?:\/\/[^\s]+)$/;

// Sistema de reconexión mejorado
const MAX_RECONNECT_ATTEMPTS = 5;
let reconnectAttempts = 0;

bot.on('polling_error', async (error) => {
    console.log('Error de polling detectado:', error.message);
    
    if (isReconnecting) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.log('Máximo de intentos de reconexión alcanzado. Reiniciando contador...');
        reconnectAttempts = 0;
        isReconnecting = false;
        return;
    }

    isReconnecting = true;
    try {
        console.log(`Intento de reconexión ${reconnectAttempts + 1}/${MAX_RECONNECT_ATTEMPTS}`);
        await bot.stopPolling();
        await new Promise(resolve => setTimeout(resolve, 5000));
        await bot.startPolling();
        console.log('Reconexión exitosa');
        reconnectAttempts = 0;
    } catch (err) {
        console.error('Error en la reconexión:', err.message);
        reconnectAttempts++;
    } finally {
        isReconnecting = false;
    }
});

// Manejador de errores mejorado
bot.on('error', (error) => {
    console.log('Error general del bot:', error.message);
});

// Mantener el bot vivo con mejor manejo de errores
const keepAliveInterval = setInterval(() => {
    try {
        bot.getMe().catch(error => {
            console.log('Error en keepalive, intentando reconectar...');
            if (!isReconnecting) {
                bot.stopPolling().then(() => bot.startPolling());
            }
        });
    } catch (error) {
        console.error('Error en el intervalo de keepalive:', error);
    }
}, 25000);

// Manejo de errores global
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
});

process.on('uncaughtException', (error) => {
    console.error('Excepción no capturada:', error);
});

function formatProgress(progress, total) {
    const percent = (progress / total * 100).toFixed(1);
    const progressBar = '█'.repeat(Math.floor(progress / total * 20)) + '░'.repeat(20 - Math.floor(progress / total * 20));
    const downloaded = (progress / (1024 * 1024)).toFixed(2);
    const totalSize = (total / (1024 * 1024)).toFixed(2);
    return `${progressBar}\n${percent}% (${downloaded}MB / ${totalSize}MB)`;
}

async function updateProgressMessage(chatId, messageId, progress, total, action = 'Descargando') {
    try {
        // Verificar si ha pasado suficiente tiempo desde la última actualización
        const now = Date.now();
        if (lastUpdateTime[chatId] && now - lastUpdateTime[chatId] < 1000) { // Reducido a 1 segundo
            return;
        }

        const percent = (progress / total * 100).toFixed(1);
        const progressBar = '█'.repeat(Math.floor(progress / total * 20)) + '░'.repeat(20 - Math.floor(progress / total * 20));
        const downloaded = (progress / (1024 * 1024)).toFixed(2);
        const totalSize = (total / (1024 * 1024)).toFixed(2);
        
        const progressText = `⏳ ${action}...\n\n${progressBar}\n${percent}% (${downloaded}MB / ${totalSize}MB)`;
        
        await bot.editMessageText(progressText, {
            chat_id: chatId,
            message_id: messageId
        }).catch(error => {
            // Solo ignorar errores específicos
            if (!error.message.includes('message is not modified') && 
                !error.message.includes('message to edit not found') &&
                !error.message.includes('429')) {
                console.log('Error en actualización:', error.message);
            }
        });
        
        lastUpdateTime[chatId] = now;
    } catch (error) {
        console.log('Error en actualización de progreso:', error.message);
        // No lanzar el error para evitar interrumpir el proceso
    }
}

async function uploadToArchive(chatId, messageId) {
    try {
        const { fileUrl, fileName, title, description, collection } = uploadData[chatId];

        // Sistema de heartbeat
        let lastProgressTime = Date.now();
        const heartbeatInterval = setInterval(() => {
            const now = Date.now();
            if (now - lastProgressTime > 10000) { // Si no hay actualización en 10 segundos
                console.log('Heartbeat: Verificando progreso...');
                bot.editMessageText('⏳ Procesando... por favor espere...', {
                    chat_id: chatId,
                    message_id: messageId
                }).catch(() => {});
            }
        }, 10000);

        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 30000
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const totalSize = parseInt(response.headers.get('content-length'));
        let downloadProgress = 0;

        // Descarga con barra de progreso mejorada
        const buffer = await new Promise(async (resolve, reject) => {
            try {
                const chunks = [];
                let lastUpdateTime = Date.now();

                for await (const chunk of response.body) {
                    chunks.push(chunk);
                    downloadProgress += chunk.length;
                    
                    // Actualizar progreso cada 2 segundos
                    const now = Date.now();
                    if (now - lastUpdateTime >= 2000) {
                        await updateProgressMessage(
                            chatId, 
                            messageId, 
                            downloadProgress, 
                            totalSize, 
                            'Descargando'
                        );
                        lastUpdateTime = now;
                        lastProgressTime = now; // Actualizar tiempo del heartbeat
                    }
                }
                resolve(Buffer.concat(chunks));
            } catch (error) {
                reject(error);
            }
        });

        // Generar identificador único
        const identifier = `${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;

        // Iniciar subida con barra de progreso
        let uploadProgress = 0;
        const uploadStartTime = Date.now();

        // Crear streams para la subida
        const readable = new stream.Readable();
        readable._read = () => {};
        readable.push(buffer);
        readable.push(null);

        // Stream de progreso mejorado
        const progressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadProgress += chunk.length;
                const now = Date.now();
                
                // Actualizar progreso cada 2 segundos
                if (now - lastProgressTime >= 2000) {
                    updateProgressMessage(
                        chatId,
                        messageId,
                        uploadProgress,
                        buffer.length,
                        'Subiendo a Archive.org'
                    ).catch(() => {});
                    lastProgressTime = now;
                }
                callback(null, chunk);
            }
        });

        // Subir a Archive.org con retry
        let retryCount = 0;
        const maxRetries = 3;
        let uploadSuccess = false;

        while (!uploadSuccess && retryCount < maxRetries) {
            try {
                const uploadResponse = await fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
                    method: 'PUT',
                    headers: {
                        'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`,
                        'Content-Type': 'video/mp4',
                        'Content-Length': buffer.length.toString(),
                        'x-archive-queue-derive': '0',
                        'x-archive-auto-make-bucket': '1',
                        'x-archive-meta-mediatype': 'movies',
                        'x-archive-size-hint': buffer.length.toString(),
                        'x-archive-meta-title': title,
                        'x-archive-meta-description': description || '',
                        'x-archive-meta-collection': collection
                    },
                    body: readable.pipe(progressStream),
                    timeout: 60000
                });

                if (!uploadResponse.ok) {
                    throw new Error(`Error en la subida: ${await uploadResponse.text()}`);
                }

                uploadSuccess = true;
            } catch (error) {
                retryCount++;
                if (retryCount < maxRetries) {
                    console.log(`Reintento ${retryCount} de ${maxRetries}`);
                    await new Promise(resolve => setTimeout(resolve, 5000)); // Esperar 5 segundos antes de reintentar
                } else {
                    throw error;
                }
            }
        }

        // Limpiar el intervalo de heartbeat
        clearInterval(heartbeatInterval);

        // Esperar para que Archive.org procese el archivo
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener la URL del stream
        const directUrl = await getCorrectStreamUrl(identifier, fileName);

        await bot.sendMessage(chatId,
            '✅ ¡Archivo subido exitosamente!\n\n' +
            `📋 Página: https://archive.org/details/${identifier}\n` +
            (directUrl ? `🎬 Stream directo: ${directUrl}\n` : '') +
            `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}`
        );

        // Limpiar
        delete lastUpdateTime[chatId];
        return true;

    } catch (error) {
        clearInterval(heartbeatInterval); // Asegurar que se limpie el intervalo en caso de error
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, '❌ Error en la subida: ' + error.message);
        delete lastUpdateTime[chatId];
        throw error;
    }
}

async function getCorrectStreamUrl(identifier, fileName) {
    try {
        await new Promise(resolve => setTimeout(resolve, 5000)); // Esperar 5 segundos
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const data = await response.json();
        
        if (data && data.files) {
            const file = data.files.find(f => f.name === fileName);
            if (file && file.format === 'h.264') {
                return `https://archive.org/download/${identifier}/${fileName}`;
            }
        }
        return null;
    } catch (error) {
        console.error('Error al obtener URL del stream:', error);
        return null;
    }
}

async function handleAccessKey(msg) {
    const chatId = msg.chat.id;
    const accessKey = msg.text.trim();
    
    if (accessKey.length < 1) {
        bot.sendMessage(chatId, '❌ Access Key inválida. No puede estar vacía.');
        return;
    }
    
    sessions[chatId] = { accessKey };
    userStates[chatId] = States.AWAITING_SECRET_KEY;
    bot.sendMessage(chatId, '🔐 Ahora envía tu Secret Key');
}

async function handleSecretKey(msg) {
    const chatId = msg.chat.id;
    const secretKey = msg.text.trim();

    if (secretKey.length < 1) {
        return bot.sendMessage(chatId, '❌ Secret Key inválida. No puede estar vacía.');
    }

    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000); // 10 segundos

        const testResponse = await fetch('https://s3.us.archive.org', {
            method: 'HEAD',
            headers: {
                'Authorization': `LOW ${sessions[chatId].accessKey}:${secretKey}`,
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            signal: controller.signal,
            agent: new https.Agent({
                rejectUnauthorized: true,
                keepAlive: true,
                timeout: 10000 // 10 segundos
            })
        }).finally(() => clearTimeout(timeout));

        if (testResponse.ok) {
            sessions[chatId].secretKey = secretKey;
            userStates[chatId] = States.IDLE;
            await bot.sendMessage(chatId, '✅ Login exitoso!\n\nAhora puedes enviar videos.');
        } else {
            throw new Error('Credenciales inválidas');
        }
    } catch (error) {
        delete sessions[chatId];
        let errorMessage = '❌ Error en el login. ';
        
        if (error.name === 'AbortError') {
            errorMessage += 'La conexión tardó más de 10 segundos. ';
        } else if (error.code === 'ECONNRESET' || error.code === 'EFATAL') {
            errorMessage += 'Error de conexión. ';
        }
        
        errorMessage += 'Por favor, verifica tu conexión e intenta nuevamente con /login';
        
        await bot.sendMessage(chatId, errorMessage);
        console.error('Error de login:', error);
    }
}

bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId,
        '🎴 Bienvenido al Bot de Archive.org\n\n' +
        'Para subir archivos grandes (hasta 2GB):\n' +
        '1. Sube tu archivo a un servicio de almacenamiento\n' +
        '2. Copia la URL directa de descarga\n' +
        '3. Envía la URL al bot\n\n' +
        'Comandos:\n' +
        '/login - Iniciar sesión\n' +
        '/logout - Cerrar sesión\n' +
        '/status - Ver estado\n' +
        '/upload - Iniciar subida por URL\n' +
        '/edit - Editar tus uploads y agregar archivos\n\n' +
        'Obtén tus credenciales en:\n' +
        'https://archive.org/account/s3.php'
    );
});

bot.onText(/\/edit/, async (msg) => {
    const chatId = msg.chat.id;
    if (!sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
    }

    try {
        const waitMessage = await bot.sendMessage(chatId, '🔍 Buscando tus uploads...');
        
        // Intentar diferentes métodos de búsqueda
        let items = [];
        const searchQueries = [
            `creator:(${encodeURIComponent(sessions[chatId].accessKey)})`,
            `uploader:(${encodeURIComponent(sessions[chatId].accessKey)})`,
            `creator:(${encodeURIComponent(sessions[chatId].accessKey.split('@')[0])})`
        ];

        for (const query of searchQueries) {
            const searchUrl = `https://archive.org/advancedsearch.php?q=${query}&fl[]=identifier,title,description,collection&sort[]=date+desc&output=json&rows=50`;
            const response = await fetch(searchUrl);
            const data = await response.json();

            if (data.response?.docs?.length > 0) {
                items = data.response.docs;
                break;
            }
        }

        if (items.length > 0) {
            let message = '📚 Tus uploads en Archive.org:\n\n';
            const keyboard = [];

            // Crear el teclado con los items encontrados
            items.forEach((item, index) => {
                const title = item.title || item.identifier;
                const displayTitle = title.length > 30 ? title.substring(0, 27) + '...' : title;
                message += `${index + 1}. ${title}\n`;
                
                keyboard.push([{
                    text: `📝 ${displayTitle}`,
                    callback_data: `edit_${item.identifier}`
                }]);
            });

            // Dividir el teclado en grupos de 5 botones
            const groupedKeyboard = [];
            for (let i = 0; i < keyboard.length; i += 5) {
                groupedKeyboard.push(...keyboard.slice(i, i + 5));
            }

            await bot.deleteMessage(chatId, waitMessage.message_id);

            // Enviar el mensaje con el teclado
            await bot.sendMessage(chatId, message, {
                reply_markup: {
                    inline_keyboard: groupedKeyboard
                }
            });
        } else {
            await bot.deleteMessage(chatId, waitMessage.message_id);
            await bot.sendMessage(chatId, '❌ No se encontraron uploads en tu cuenta. Verifica que estés usando las credenciales correctas.');
        }
    } catch (error) {
        console.error('Error al buscar uploads:', error);
        await bot.sendMessage(chatId, '❌ Error al buscar tus uploads. Por favor, intenta más tarde.');
    }
});

bot.onText(/\/upload/, (msg) => {
    const chatId = msg.chat.id;
    if (!sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
    }
    userStates[chatId] = States.AWAITING_FILE;
    bot.sendMessage(chatId, 
        '🔗 Envía la URL directa del archivo de video\n' +
        'Ejemplo: https://ejemplo.com/video.mp4\n' +
        'El archivo debe ser menor a 2GB'
    );
});

bot.onText(/\/login/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        return bot.sendMessage(chatId, '❌ Ya tienes una sesión activa. Usa /logout primero si quieres cambiar de cuenta.');
    }
    userStates[chatId] = States.AWAITING_ACCESS_KEY;
    bot.sendMessage(chatId, '🔑 Por favor, envía tu Access Key de Archive.org S3');
});

bot.onText(/\/logout/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        delete sessions[chatId];
        userStates[chatId] = States.IDLE;
        bot.sendMessage(chatId, '✅ Sesión cerrada exitosamente');
    } else {
        bot.sendMessage(chatId, '❌ No hay sesión activa');
    }
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id;
    if (sessions[chatId]) {
        bot.sendMessage(chatId, `🔷 Sesión activa con Access Key: ${sessions[chatId].accessKey}`);
    } else {
        bot.sendMessage(chatId, '❌ No hay sesión activa');
    }
});

async function handleFileUrl(msg) {
    const chatId = msg.chat.id;
    const url = msg.text;

    try {
        const statusMessage = await bot.sendMessage(chatId, '🔍 Verificando enlace...');
        
        const response = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) {
            throw new Error('No se puede acceder al archivo');
        }

        const contentLength = response.headers.get('content-length');
        const contentType = response.headers.get('content-type');

        let fileName = url.split('/').pop().split('?')[0] || 'video.mp4';
        if (!fileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
            fileName += '.mp4';
        }

        uploadData[chatId] = {
            fileUrl: url,
            fileName: fileName,
            mimeType: contentType || 'video/mp4',
            fileSize: contentLength ? parseInt(contentLength) : null,
            statusMessageId: statusMessage.message_id
        };

        await bot.editMessageText(
            `✅ Enlace verificado\n\n` +
            `📁 Nombre: ${fileName}\n` +
            `💾 Tamaño: ${contentLength ? (parseInt(contentLength) / (1024 * 1024)).toFixed(2) + ' MB' : 'Desconocido'}`,
            {
                chat_id: chatId,
                message_id: statusMessage.message_id,
                reply_markup: {
                    inline_keyboard: [
                        [{text: '✏️ Renombrar archivo', callback_data: 'rename_file'}],
                        [{text: '✅ Continuar', callback_data: 'continue_upload'}]
                    ]
                }
            }
        );
    } catch (error) {
        await bot.sendMessage(chatId, '❌ Error con la URL: ' + error.message);
    }
}

async function handleEditItem(chatId, identifier) {
    try {
        const response = await fetch(`https://archive.org/metadata/${identifier}`);
        const metadata = await response.json();
        
        if (metadata && metadata.metadata) {
            const files = metadata.files || [];
            const videoFiles = files.filter(file => 
                file.name.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)
            );

            let message = 
                `📝 Detalles del item:\n\n` +
                `📌 Título: ${metadata.metadata.title || 'No disponible'}\n` +
                `🔍 ID: ${identifier}\n` +
                `📚 Colección: ${metadata.metadata.collection || 'No disponible'}\n` +
                `📝 Descripción: ${metadata.metadata.description || 'No disponible'}\n\n` +
                `📁 Archivos actuales: ${videoFiles.length}\n`;

            videoFiles.forEach(file => {
                message += `▫️ ${file.name} (${(file.size / (1024 * 1024)).toFixed(2)} MB)\n`;
            });

            message += '\n¿Qué deseas hacer?';

            const keyboard = [
                [{text: '✏️ Editar Título', callback_data: `edit_title_${identifier}`}],
                [{text: '📝 Editar Descripción', callback_data: `edit_desc_${identifier}`}],
                [{text: '📚 Editar Colección', callback_data: `edit_coll_${identifier}`}],
                [{text: '📤 Agregar Nuevo Archivo', callback_data: `add_file_${identifier}`}],
                [{text: '🔙 Volver', callback_data: 'back_to_list'}]
            ];

            await bot.sendMessage(chatId, message, {
                reply_markup: {
                    inline_keyboard: keyboard
                }
            });
        } else {
            throw new Error('No se pudo obtener la información del item');
        }
    } catch (error) {
        console.error('Error al obtener detalles:', error);
        await bot.sendMessage(chatId, '❌ Error al obtener detalles del item');
    }
}

async function addFileToExisting(chatId, identifier, fileUrl, fileName) {
    try {
        const statusMessage = await bot.sendMessage(chatId, '⏳ Iniciando descarga del nuevo archivo...');
        
        const response = await fetch(fileUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        if (!response.ok) throw new Error('Error al obtener el archivo');

        const totalSize = parseInt(response.headers.get('content-length'));
        let downloadProgress = 0;
        const chunks = [];

        // Descarga con barra de progreso
        const buffer = await new Promise(async (resolve, reject) => {
            try {
                const chunks = [];
                for await (const chunk of response.body) {
                    chunks.push(chunk);
                    downloadProgress += chunk.length;
                    await updateProgressMessage(
                        chatId, 
                        statusMessage.message_id, 
                        downloadProgress, 
                        totalSize, 
                        'Descargando'
                    );
                }
                resolve(Buffer.concat(chunks));
            } catch (error) {
                reject(error);
            }
        });

        // Iniciar subida con barra de progreso
        await updateProgressMessage(
            chatId,
            statusMessage.message_id,
            0,
            buffer.length,
            'Subiendo a Archive.org'
        );

        // Crear un stream de lectura desde el buffer
        const readable = new stream.Readable();
        readable._read = () => {}; // _read es requerido pero puede estar vacío
        readable.push(buffer);
        readable.push(null);

        // Crear un stream que reporta el progreso
        let uploadProgress = 0;
        const progressStream = new stream.Transform({
            transform(chunk, encoding, callback) {
                uploadProgress += chunk.length;
                updateProgressMessage(
                    chatId,
                    statusMessage.message_id,
                    uploadProgress,
                    buffer.length,
                    'Subiendo a Archive.org'
                ).catch(() => {}); // Ignorar errores de actualización
                callback(null, chunk);
            }
        });

        // Subir el archivo a Archive.org con progreso
        const uploadResponse = await new Promise((resolve, reject) => {
            const uploadStream = fetch(`https://s3.us.archive.org/${identifier}/${fileName}`, {
                method: 'PUT',
                headers: {
                    'Authorization': `LOW ${sessions[chatId].accessKey}:${sessions[chatId].secretKey}`,
                    'Content-Type': 'video/mp4',
                    'Content-Length': buffer.length.toString(),
                    'x-archive-queue-derive': '0',
                    'x-archive-auto-make-bucket': '1',
                    'x-archive-meta-mediatype': 'movies',
                    'x-archive-size-hint': buffer.length.toString()
                },
                body: readable.pipe(progressStream)
            });
            
            uploadStream.then(resolve).catch(reject);
        });

        if (!uploadResponse.ok) {
            throw new Error(`Error en la subida: ${await uploadResponse.text()}`);
        }

        // Esperar un momento para que Archive.org procese el archivo
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Obtener la URL del stream
        const directUrl = await getCorrectStreamUrl(identifier, fileName);

        await bot.sendMessage(chatId,
            '✅ ¡Archivo agregado exitosamente!\n\n' +
            `📋 Página: https://archive.org/details/${identifier}\n` +
            (directUrl ? `🎬 Stream directo: ${directUrl}\n` : '') +
            `⬇️ Descarga: https://archive.org/download/${identifier}/${fileName}`
        );

        // Eliminar el mensaje de estado
        await bot.deleteMessage(chatId, statusMessage.message_id);
        delete lastUpdateTime[chatId];

    } catch (error) {
        console.error('Error completo:', error);
        await bot.sendMessage(chatId, '❌ Error al agregar el archivo: ' + error.message);
        delete lastUpdateTime[chatId];
    } finally {
        userStates[chatId] = States.IDLE;
        delete uploadData[chatId];
    }
}

async function updateItemMetadata(identifier, metadata, accessKey, secretKey) {
    const url = `https://archive.org/metadata/${identifier}`;
    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `LOW ${accessKey}:${secretKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                ...metadata,
                '-target': 'metadata'
            })
        });

        if (!response.ok) {
            throw new Error(`Error al actualizar: ${await response.text()}`);
        }

        return true;
    } catch (error) {
        console.error('Error al actualizar metadatos:', error);
        throw error;
    }
}

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    if (data === 'rename_file') {
        userStates[chatId] = States.AWAITING_RENAME;
        await bot.sendMessage(chatId, '📝 Envía el nuevo nombre para el archivo (incluyendo la extensión):');
    } else if (data === 'continue_upload') {
        userStates[chatId] = States.AWAITING_TITLE;
        await bot.sendMessage(chatId, '📝 Envía un título para el video:');
    } else if (data.startsWith('edit_title_')) {
        const identifier = data.replace('edit_title_', '');
        userStates[chatId] = States.EDITING_TITLE;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📝 Envía el nuevo título:');
    } else if (data.startsWith('edit_desc_')) {
        const identifier = data.replace('edit_desc_', '');
        userStates[chatId] = States.EDITING_DESCRIPTION;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📝 Envía la nueva descripción:');
    } else if (data.startsWith('edit_coll_')) {
        const identifier = data.replace('edit_coll_', '');
        userStates[chatId] = States.EDITING_COLLECTION;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, '📚 Envía el nuevo nombre de la colección:');
    } else if (data.startsWith('add_file_')) {
        const identifier = data.replace('add_file_', '');
        userStates[chatId] = States.AWAITING_NEW_FILE_URL;
        uploadData[chatId] = { editingIdentifier: identifier };
        await bot.sendMessage(chatId, 
            '🔗 Envía la URL directa del nuevo archivo de video\n' +
            'Ejemplo: https://ejemplo.com/video.mp4\n' +
            'El archivo debe ser menor a 2GB'
        );
    } else if (data === 'back_to_list') {
        await bot.deleteMessage(chatId, messageId);
        const msg = { chat: { id: chatId } };
        bot.emit('text', msg, { text: '/edit' });
    } else if (data.startsWith('edit_')) {
        const identifier = data.replace('edit_', '');
        await handleEditItem(chatId, identifier);
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId] || States.IDLE;

    if (msg.text && msg.text.startsWith('/')) return;

    if (msg.video) {
        if (!sessions[chatId]) {
            return bot.sendMessage(chatId, '❌ Primero debes iniciar sesión con /login');
        }
        if (userStates[chatId] === States.UPLOADING) {
            return bot.sendMessage(chatId, '⏳ Ya hay una subida en proceso. Por favor espera.');
        }
        await handleVideoUpload(msg);
        return;
    }

    switch(state) {
        case States.AWAITING_ACCESS_KEY:
            handleAccessKey(msg);
            break;
        case States.AWAITING_SECRET_KEY:
            handleSecretKey(msg);
            break;
        case States.AWAITING_FILE:
            if (msg.text && urlRegex.test(msg.text)) {
                handleFileUrl(msg);
            } else {
                bot.sendMessage(chatId, '❌ Por favor, envía una URL válida');
            }
            break;
        case States.AWAITING_TITLE:
            handleTitle(msg);
            break;
        case States.AWAITING_DESCRIPTION:
            handleDescription(msg);
            break;
        case States.AWAITING_COLLECTION:
            handleCollection(msg);
            break;
        case States.AWAITING_RENAME:
            handleRename(msg);
            break;
        case States.EDITING_TITLE:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    title: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Título actualizado correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar el título');
            }
            break;
        case States.EDITING_DESCRIPTION:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    description: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Descripción actualizada correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar la descripción');
            }
            break;
        case States.EDITING_COLLECTION:
            try {
                await updateItemMetadata(uploadData[chatId].editingIdentifier, {
                    collection: msg.text
                }, sessions[chatId].accessKey, sessions[chatId].secretKey);
                await bot.sendMessage(chatId, '✅ Colección actualizada correctamente');
                userStates[chatId] = States.IDLE;
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al actualizar la colección');
            }
            break;
        case States.AWAITING_NEW_FILE_URL:
            if (msg.text && urlRegex.test(msg.text)) {
                uploadData[chatId].newFileUrl = msg.text;
                userStates[chatId] = States.AWAITING_NEW_FILE_NAME;
                await bot.sendMessage(chatId, '📝 Envía el nombre para el nuevo archivo (incluyendo la extensión):');
            } else {
                await bot.sendMessage(chatId, '❌ Por favor, envía una URL válida');
            }
            break;
        case States.AWAITING_NEW_FILE_NAME:
            const fileName = msg.text.trim();
            if (!fileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
                return bot.sendMessage(chatId, '❌ El nombre debe incluir una extensión válida (.mp4, .mkv, etc.)');
            }
            try {
                await addFileToExisting(
                    chatId,
                    uploadData[chatId].editingIdentifier,
                    uploadData[chatId].newFileUrl,
                    fileName
                );
            } catch (error) {
                await bot.sendMessage(chatId, '❌ Error al agregar el archivo: ' + error.message);
            }
            break;
    }
});

async function handleTitle(msg) {
    const chatId = msg.chat.id;
    const title = msg.text.trim();
    
    if (title.length < 1) {
        bot.sendMessage(chatId, '❌ El título no puede estar vacío. Por favor, envía un título válido.');
        return;
    }
    
    uploadData[chatId].title = title;
    userStates[chatId] = States.AWAITING_DESCRIPTION;
    bot.sendMessage(chatId, 
        '📝 Envía una descripción para el video\n' +
        '(Opcional - envía "skip" para omitir)'
    );
}

async function handleDescription(msg) {
    const chatId = msg.chat.id;
    if (msg.text.toLowerCase() !== 'skip') {
        uploadData[chatId].description = msg.text;
    }
    userStates[chatId] = States.AWAITING_COLLECTION;
    bot.sendMessage(chatId,
        '📚 Envía el nombre de la colección\n' +
        '(Obligatorio - usa "opensource_media" si no estás seguro)'
    );
}

async function handleCollection(msg) {
    const chatId = msg.chat.id;
    uploadData[chatId].collection = msg.text;
    userStates[chatId] = States.UPLOADING;
    const statusMessage = await bot.sendMessage(chatId, '🚀 Iniciando subida...');
    
    try {
        await uploadToArchive(chatId, statusMessage.message_id);
    } catch (error) {
        console.error('Error en la subida:', error);
    } finally {
        userStates[chatId] = States.IDLE;
        delete uploadData[chatId];
    }
}

async function handleRename(msg) {
    const chatId = msg.chat.id;
    const newFileName = msg.text.trim();

    if (!newFileName.match(/\.(mp4|mkv|avi|mov|wmv|flv|webm)$/i)) {
        return bot.sendMessage(chatId, '❌ El nombre debe incluir una extensión válida (.mp4, .mkv, etc.)');
    }

    uploadData[chatId].fileName = newFileName;
    userStates[chatId] = States.AWAITING_TITLE;
    await bot.sendMessage(chatId, `✅ Archivo renombrado a: ${newFileName}\n\n📝 Ahora envía un título para la pagina:`);
}

// Manejo de errores global
process.on('unhandledRejection', (error) => {
    console.error('Error no manejado:', error);
});

console.log('Bot iniciado correctamente');
