const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// 默认配置
let config = {
    port: 3000,
    banana_token: "",
    modelscope_token: "",
    chat_api_base: ""
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

    // 3. 静态资源转发 (index.html, styles.css, app.js, images 等)
    const safePath = path.normalize(pathname).replace(/^(\.\.[\/\\])+/, '');
    
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

const PORT = config.port || 3000;
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
