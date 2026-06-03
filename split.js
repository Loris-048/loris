const fs = require('fs');
const path = require('path');

const srcPath = path.resolve(__dirname, '../index_v6.1.html');
const destDir = path.resolve(__dirname, 'public');

if (!fs.existsSync(destDir)) {
    fs.mkdirSync(destDir, { recursive: true });
}

console.log('🔍 开始对 ' + srcPath + ' 进行高精度结构拆分...');

if (!fs.existsSync(srcPath)) {
    console.error('❌ 错误：找不到源 HTML 文件：', srcPath);
    process.exit(1);
}

const content = fs.readFileSync(srcPath, 'utf8');

// 1. 提取 CSS
console.log('🎨 正在提取 CSS 样式表...');
const styleStartTag = '<style>';
const styleEndTag = '</style>';
const styleStartIndex = content.indexOf(styleStartTag);
const styleEndIndex = content.indexOf(styleEndTag, styleStartIndex);

let cssContent = '';
let htmlWithoutStyle = content;

if (styleStartIndex !== -1 && styleEndIndex !== -1) {
    cssContent = content.substring(styleStartIndex + styleStartTag.length, styleEndIndex).trim();
    // 将原 style 标签替换为 css 外部引用占位符
    htmlWithoutStyle = content.substring(0, styleStartIndex) + 
                       '    <link rel="stylesheet" href="styles.css">' + 
                       content.substring(styleEndIndex + styleEndTag.length);
} else {
    console.warn('⚠️ 警告：未在 HTML 中找到 <style> 标签！');
}

// 2. 提取 JS（合并多个 script 标签中的 JS）
console.log('⚡ 正在提取 JavaScript 脚本...');
const scriptStartRegex = /<script\b[^>]*>/gi;
const scriptEndTag = '</script>';

let jsBlocks = [];
let htmlWithoutScripts = '';
let lastIndex = 0;

let match;
while ((match = scriptStartRegex.exec(htmlWithoutStyle)) !== null) {
    const startTagIndex = match.index;
    const startTagLength = match[0].length;
    const endTagIndex = htmlWithoutStyle.indexOf(scriptEndTag, startTagIndex);

    if (endTagIndex !== -1) {
        // 拼接 HTML（保留 script 标签之前的内容）
        htmlWithoutScripts += htmlWithoutStyle.substring(lastIndex, startTagIndex);
        
        // 提取 JS 内容
        const jsCode = htmlWithoutStyle.substring(startTagIndex + startTagLength, endTagIndex).trim();
        if (jsCode) {
            jsBlocks.push(jsCode);
        }
        
        lastIndex = endTagIndex + scriptEndTag.length;
    } else {
        console.warn('⚠️ 警告：检测到未闭合的 <script> 标签！');
    }
}
// 拼接剩余的 HTML
htmlWithoutScripts += htmlWithoutStyle.substring(lastIndex);

// 3. 构建安全的 fetch 拦截器和后端配置检测函数
const proxyInterceptor = `// =====================================================================
// 🔒 安全网络拦截代理器 (核心防盗防复制设计)
// =====================================================================
(function() {
    const originalFetch = window.fetch;
    window._originalFetch = originalFetch; // 保留原始引用方便非代理状态下使用

    window.fetch = async function(url, options) {
        // 1. 如果是本地资源（如 styles.css、/api/config 等）、局域网 IP 或 data URL，直接放行
        if (typeof url === 'string') {
            if (!url.startsWith('http://') && !url.startsWith('https://')) {
                return originalFetch(url, options);
            }
            if (url.includes(window.location.host)) {
                return originalFetch(url, options);
            }
            if (url.startsWith('data:')) {
                return originalFetch(url, options);
            }
        }

        // 2. 如果是通过 file:// 协议直接双击打开（如拷贝到家里的电脑），则直接向官方 API 发送请求
        if (window.location.protocol === 'file:' || window.location.hostname === '') {
            return originalFetch(url, options);
        }

        // 3. 工作模式下：将所有外部 API 请求转发给安全的本地后端进行 Token 注入
        const headers = new Headers(options?.headers || {});
        headers.set('X-Target-URL', url);

        const proxyOptions = {
            ...options,
            headers: headers
        };

        try {
            return await originalFetch('/api/proxy', proxyOptions);
        } catch (e) {
            console.warn('⚠️ 本地代理服务请求失败，正在尝试直接连接官方接口:', e);
            return originalFetch(url, options);
        }
    };

    // 初始化时检测后端密钥配置
    async function checkBackendConfig() {
        try {
            const resp = await originalFetch('/api/config');
            if (resp.ok) {
                const config = await resp.json();
                if (config.hasBananaToken) {
                    const tokenInput = document.getElementById('token');
                    if (tokenInput) {
                        tokenInput.value = '********';
                        tokenInput.disabled = true;
                        tokenInput.type = 'password';
                        tokenInput.placeholder = '🔒 密钥已由本地安全后端托管 (同事不可见)';
                        const toggle = tokenInput.nextElementSibling;
                        if (toggle && toggle.classList.contains('token-toggle')) {
                            toggle.style.display = 'none';
                        }
                    }
                }
                if (config.hasModelScopeToken) {
                    const msInput = document.getElementById('modelscopeToken');
                    if (msInput) {
                        msInput.value = '********';
                        msInput.disabled = true;
                        msInput.type = 'password';
                        msInput.placeholder = '🔒 密钥已由本地安全后端托管 (同事不可见)';
                        const toggle = msInput.nextElementSibling;
                        if (toggle && toggle.classList.contains('token-toggle')) {
                            toggle.style.display = 'none';
                        }
                    }
                }
            }
        } catch (e) {
            console.warn('🔔 未检测到本地安全后端，使用标准直连模式。', e);
        }
    }

    // 在页面加载完毕后运行密钥检测
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', checkBackendConfig);
    } else {
        checkBackendConfig();
    }
})();\n\n`;

// 组合所有的 JavaScript 代码
const finalJsContent = proxyInterceptor + jsBlocks.join('\n\n// ==================== 拆分代码段 ====================\n\n');

// 4. 重构 HTML，将唯一的 app.js 外部引用放至 </body> 前
console.log('🏗️ 正在重构 HTML 主结构...');
let finalHtml = htmlWithoutScripts;
const bodyEndIndex = finalHtml.lastIndexOf('</body>');

if (bodyEndIndex !== -1) {
    finalHtml = finalHtml.substring(0, bodyEndIndex) + 
                '    <script src="app.js"></script>\n' + 
                finalHtml.substring(bodyEndIndex);
} else {
    finalHtml += '\n<script src="app.js"></script>';
}

// 5. 写入拆分后的文件
console.log('💾 正在写入文件到硬盘...');
fs.writeFileSync(path.join(destDir, 'styles.css'), cssContent, 'utf8');
fs.writeFileSync(path.join(destDir, 'app.js'), finalJsContent, 'utf8');
fs.writeFileSync(path.join(destDir, 'index.html'), finalHtml, 'utf8');

console.log('====================================================');
console.log('🎉 拆分圆满成功！');
console.log('📂 样式文件已保存为: public/styles.css');
console.log('📂 逻辑文件已保存为: public/app.js (已注入安全拦截器)');
console.log('📂 主页面已保存为:   public/index.html');
console.log('====================================================');
