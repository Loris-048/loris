const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 默认配置
let config = {
    port: 3005,
    banana_token: "",
    modelscope_token: "",
    chat_api_base: "",
    storage_path: "" // 新增：用户自定义落盘物理路径
};

// 读取或创建配置文件
if (fs.existsSync(CONFIG_PATH)) {
    try {
        const fileData = fs.readFileSync(CONFIG_PATH, 'utf8');
        config = { ...config, ...JSON.parse(fileData) };
    } catch (e) {
        console.error('⚠️ 读取 config.json 失败，使用默认配置:', e);
    }
} else {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
    console.log('📝 已在本地自动为您生成空配置文件: config.json');
}

// 动态解析物理落盘的总目录，若为空则默认存放在 Loirs 同级的 Loirs_Data 目录下
function getStorageRoot() {
    if (config.storage_path && config.storage_path.trim()) {
        return path.resolve(config.storage_path.trim());
    }
    return path.resolve(path.join(__dirname, '..', 'Loirs_Data'));
}

// 确保本地物理磁盘输出文件夹及 常规/套图/对话 三大子目录存在
function ensureStorageDirs() {
    const root = getStorageRoot();
    const output = path.join(root, 'output');
    const single = path.join(output, '常规');
    const suite = path.join(output, '套图');
    const chat = path.join(output, '对话');
    
    [root, output, single, suite, chat].forEach(dir => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// 获取历史数据库 history.json 文件的物理路径
function getHistoryPath() {
    return path.join(getStorageRoot(), 'history.json');
}

// 磁盘轻量 JSON 数据库读取
function getHistory() {
    ensureStorageDirs();
    const historyPath = getHistoryPath();
    if (fs.existsSync(historyPath)) {
        try {
            return JSON.parse(fs.readFileSync(historyPath, 'utf8'));
        } catch (e) {
            console.error('⚠️ 读取 history.json 失败:', e);
            return [];
        }
    }
    return [];
}

// 磁盘轻量 JSON 数据库写入
function saveHistory(history) {
    ensureStorageDirs();
    fs.writeFileSync(getHistoryPath(), JSON.stringify(history, null, 4), 'utf8');
}

// 深度过滤 Windows/Linux 文件系统禁用字符，让文件夹名字安全无暇
function sanitizeFolderName(name) {
    if (!name || !name.trim()) return '未命名对话';
    // 替换特殊危险字符如 \ / : * ? " < > | 为下划线
    let sanitized = name.trim().replace(/[\\\/:\*\?"<>\|]/g, '_');
    if (sanitized.length > 100) {
        sanitized = sanitized.substring(0, 100).trim();
    }
    return sanitized;
}

// 获取目录下当前的自增文件编号（例如目录下有 5 张 png，下一张自动编为 0006）
function getNextFileNumber(dirPath) {
    try {
        if (!fs.existsSync(dirPath)) return '0001';
        const files = fs.readdirSync(dirPath).filter(f => f.toLowerCase().endsWith('.png'));
        const nextNum = files.length + 1;
        return String(nextNum).padStart(4, '0');
    } catch (e) {
        return '0001';
    }
}

// 格式化生成时间，格式 YYYYMMDD_HHMMSS
function formatTimestamp(ts) {
    const d = ts ? new Date(ts) : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const hh = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}_${hh}${min}${ss}`;
}

// 常见静态文件媒体类型
const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon'
};

// 静态文件分发服务
function serveStaticFile(req, res, filePath) {
    if (!fs.existsSync(filePath)) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 Not Found');
        return;
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
        filePath = path.join(filePath, 'index.html');
        if (!fs.existsSync(filePath)) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 Not Found');
            return;
        }
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': fs.statSync(filePath).size,
        'Cache-Control': 'no-cache, no-store, must-revalidate'
    });

    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
}

// 创建 HTTP 服务器
const server = http.createServer((req, res) => {
    // 跨域支持 (CORS) 方便局域网同事访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // 0.1 API: 嗅探本地服务器运行状态并返回当前物理路径
    if (pathname === '/api/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: "ok",
            mode: "server",
            storagePath: getStorageRoot()
        }));
        return;
    }

    // 0.2 API: 获取物理磁盘历史数据库记录
    if (pathname === '/api/history' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(getHistory()));
        return;
    }

    // 0.3 API: 物理存图与智能命名引擎
    if (pathname === '/api/save-image' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const record = JSON.parse(body);
                if (!record.id) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing id' }));
                    return;
                }
                
                if (record.imageData) {
                    // 处理 Base64 数据
                    const base64Data = record.imageData.replace(/^data:image\/\w+;base64,/, "");
                    const buffer = Buffer.from(base64Data, 'base64');
                    
                    const mode = record.mode || 'single';
                    const root = getStorageRoot();
                    let destDir = path.join(root, 'output', '常规');
                    let modeFolder = '常规';
                    
                    if (mode === 'suite') {
                        destDir = path.join(root, 'output', '套图');
                        modeFolder = '套图';
                    } else if (mode === 'chat') {
                        const chatFolderName = sanitizeFolderName(record.chatName);
                        destDir = path.join(root, 'output', '对话', chatFolderName);
                        modeFolder = '对话';
                    }
                    
                    // 确保目标子目录存在
                    if (!fs.existsSync(destDir)) {
                        fs.mkdirSync(destDir, { recursive: true });
                    }
                    
                    // 计算自增编号和时间，生成最终文件名
                    const seqNum = getNextFileNumber(destDir);
                    const timeStr = formatTimestamp(record.timestamp);
                    const imgFilename = `${seqNum}_${timeStr}.png`;
                    const imgPath = path.join(destDir, imgFilename);
                    
                    fs.writeFileSync(imgPath, buffer);
                    
                    // 构建前端可访问的相对 URL (URL 必须进行编码以防中文乱码)
                    let browserUrl = '';
                    if (mode === 'chat') {
                        const chatFolderName = sanitizeFolderName(record.chatName);
                        browserUrl = `/output/对话/${encodeURIComponent(chatFolderName)}/${imgFilename}`;
                    } else {
                        browserUrl = `/output/${encodeURIComponent(modeFolder)}/${imgFilename}`;
                    }
                    
                    // 剔除高内存消耗的 imageData，替换为轻量级 url
                    delete record.imageData;
                    record.url = browserUrl;
                }
                
                // 将记录写入历史数据库 history.json
                const history = getHistory();
                const existingIdx = history.findIndex(h => h.id === record.id);
                if (existingIdx !== -1) {
                    // 合并现有记录与更新（支持增量更新）
                    history[existingIdx] = { ...history[existingIdx], ...record };
                    record.url = history[existingIdx].url; // 保证返回的 url 依然存在
                } else {
                    history.unshift(record); // 最新生成的排在最前面
                }
                saveHistory(history);
                
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({ success: true, url: record.url }));
            } catch (e) {
                console.error('❌ 保存本地图片失败:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 0.4 API: 动态修改存储路径 (无需重启)
    if (pathname === '/api/storage-path' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                let newPath = data.path ? data.path.trim() : '';
                
                // 更新内存中的配置
                config.storage_path = newPath;
                
                // 测试在该目录下创建子目录以确保可写
                ensureStorageDirs();
                
                // 永久保存至 config.json
                fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf8');
                
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    success: true,
                    storagePath: getStorageRoot()
                }));
            } catch (e) {
                console.error('❌ 更改存储路径失败:', e);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // 0.5 API: 删除/清空历史记录并智能同步物理删除磁盘图片
    if (pathname === '/api/history' && req.method === 'DELETE') {
        const recordId = parsedUrl.query.id;
        let history = getHistory();
        
        if (recordId) {
            const record = history.find(h => h.id === recordId);
            if (record) {
                // 根据 URL 还原本地物理图片地址并将其删除
                let fileRelPath = record.url;
                if (fileRelPath && fileRelPath.startsWith('/output/')) {
                    const relativePath = decodeURIComponent(fileRelPath.substring(8));
                    const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
                    const filePath = path.join(getStorageRoot(), 'output', safeRelativePath);
                    if (fs.existsSync(filePath)) {
                        try {
                            fs.unlinkSync(filePath);
                        } catch (e) {
                            console.error('⚠️ 删除本地物理图片失败:', filePath, e);
                        }
                    }
                }
                // 从数据库中剔除
                history = history.filter(h => h.id !== recordId);
                saveHistory(history);
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
        } else {
            // 全盘清空
            saveHistory([]);
            // 递归清理物理生图目录下的所有常规/套图/对话文件
            const root = getStorageRoot();
            const subdirs = [
                path.join(root, 'output', '常规'),
                path.join(root, 'output', '套图'),
                path.join(root, 'output', '对话')
            ];
            
            subdirs.forEach(dir => {
                if (fs.existsSync(dir)) {
                    try {
                        const items = fs.readdirSync(dir);
                        items.forEach(item => {
                            const itemPath = path.join(dir, item);
                            const stat = fs.statSync(itemPath);
                            if (stat.isDirectory()) {
                                // 递归删除对话子文件夹
                                fs.rmSync(itemPath, { recursive: true, force: true });
                            } else {
                                fs.unlinkSync(itemPath);
                            }
                        });
                    } catch (e) {
                        console.error('⚠️ 清理存储子目录失败:', dir, e);
                    }
                }
            });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: true }));
        }
        return;
    }

    // 1. API: 获取配置状态（前端用来隐藏/禁用密码框）
    if (pathname === '/api/config' && req.method === 'GET') {
        const hasBanana = !!(config.banana_token && config.banana_token.trim());
        const hasModelScope = !!(config.modelscope_token && config.modelscope_token.trim());
        
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            hasBananaToken: hasBanana,
            hasModelScopeToken: hasModelScope
        }));
        return;
    }

    // 2. API: 核心安全的 API 代理转发 (SSE 流式传输支持)
    if (pathname === '/api/proxy') {
        const targetUrlStr = req.headers['x-target-url'];
        if (!targetUrlStr) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Missing X-Target-URL header');
            return;
        }

        try {
            const targetUrl = new URL(targetUrlStr);
            const isHttps = targetUrl.protocol === 'https:';
            const requestModule = isHttps ? https : http;

            // 复制并过滤请求头，防止引起证书或压缩混淆问题
            const headers = { ...req.headers };
            delete headers['host'];
            delete headers['x-target-url'];
            delete headers['connection'];
            delete headers['accept-encoding']; // 禁用 gzip 以方便透传 stream

            // 注入托管的后端 API Key
            const targetHost = targetUrl.hostname;
            if (targetHost.includes('modelscope.cn')) {
                if (config.modelscope_token && config.modelscope_token.trim()) {
                    headers['authorization'] = `Bearer ${config.modelscope_token.trim()}`;
                }
            } else {
                if (config.banana_token && config.banana_token.trim()) {
                    headers['authorization'] = `Bearer ${config.banana_token.trim()}`;
                }
            }

            const proxyReqOptions = {
                method: req.method,
                hostname: targetUrl.hostname,
                port: targetUrl.port || (isHttps ? 443 : 80),
                path: targetUrl.pathname + targetUrl.search,
                headers: headers,
                rejectUnauthorized: false // 忽略自签名证书，提高局域网连通率
            };

            const proxyReq = requestModule.request(proxyReqOptions, (proxyRes) => {
                // 写入目标服务器的状态码与响应头
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                // 实时流式流向客户端 (非常关键，保留了 SSE 正在思考的打字机流效果)
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                console.error('❌ Proxy Request Error:', err);
                res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end(`Proxy Error: ${err.message}`);
            });

            // 将前端的 POST body 请求体数据流直接转发给目标 API 
            req.pipe(proxyReq);
        } catch (e) {
            console.error('❌ Invalid Target URL:', targetUrlStr, e);
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`Invalid X-Target-URL: ${e.message}`);
        }
        return;
    }

    // 3. 静态资源和本地磁盘物理图片转发
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    
    // 拦截本地磁盘物理图片资源请求，映射回 Loirs_Data/output/...
    if (pathname.startsWith('/output/')) {
        let relativePath = pathname.substring(8);
        try {
            relativePath = decodeURIComponent(relativePath);
        } catch (e) {
            console.error('⚠️ [Static] decodeURIComponent 解析相对路径失败:', relativePath, e);
        }
        const safeRelativePath = path.normalize(relativePath).replace(/^(\.\.[\/\\])+/, '');
        const filePath = path.join(getStorageRoot(), 'output', safeRelativePath);
        
        console.log(`📁 [Static Forward]: URL ${pathname} -> 映射物理文件: ${filePath}`);
        
        serveStaticFile(req, res, filePath);
        return;
    }
    
    // 如果请求的是首页，并且已经运行了 build.js 进行了混淆打包，则优先返回无注释、已压缩的安全版本
    if (safePath === '/' || safePath === '\\' || safePath === 'index.html') {
        const bundledPath = path.join(__dirname, 'dist', 'index_bundled.html');
        if (fs.existsSync(bundledPath)) {
            serveStaticFile(req, res, bundledPath);
            return;
        }
    }
    
    const filePath = path.join(PUBLIC_DIR, safePath);
    serveStaticFile(req, res, filePath);
});

// 获取本机局域网 IP 方便分享给同事
function getLocalIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '127.0.0.1';
}

const PORT = config.port || 3005;
server.listen(PORT, '0.0.0.0', () => {
    const localIP = getLocalIP();
    console.log(`================================================================`);
    console.log(`🔒 Loris 局域网安全托管后端服务启动成功！`);
    console.log(`----------------------------------------------------------------`);
    console.log(`🌐 局域网内同事电脑访问： http://${localIP}:${PORT}`);
    console.log(`🏠 您本人的电脑本地访问： http://localhost:${PORT}`);
    console.log(`----------------------------------------------------------------`);
    console.log(`💡 提示：在同目录下的 config.json 中填入 Banana / 魔塔 API 密钥，`);
    console.log(`   同事在网页里将【无法窥视】或【拷贝】您的密钥，彻底防盗刷。`);
    console.log(`================================================================`);
});
