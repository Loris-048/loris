const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const distDir = path.join(__dirname, 'dist');

if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
}

console.log('📦 开始打包编译单文件...');

try {
    let html = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    let css = fs.readFileSync(path.join(publicDir, 'styles.css'), 'utf8');
    let js = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');

    // 1. 压缩 CSS：移除注释和多余空白
    console.log('⚡ 正在压缩 CSS 样式表...');
    css = css
        .replace(/\/\*[\s\S]*?\*\//g, '') // 移除块级注释
        .replace(/\s+/g, ' ')             // 合并连续空白字符
        .replace(/\s*([{};:])\s*/g, '$1') // 移除特殊符号周围的空白
        .trim();

    // 2. 压缩 JS：安全地过滤纯注释行，保留完整逻辑代码，绝对不截断任何有效行
    console.log('⚡ 正在安全压缩 JS (过滤整行注释，100% 安全保证)...');
    
    const lines = js.split(/\r?\n/);
    const compressedLines = [];
    
    for (let line of lines) {
        const trimmed = line.trim();
        // 过滤空行
        if (!trimmed) continue;
        
        // 只过滤整行都是单行注释的行
        if (trimmed.startsWith('//')) {
            continue;
        }
        
        // 100% 保留其他代码行，绝不在行内做双斜杠截断，确保 URL、正则表达式、SVG 完全不受损
        compressedLines.push(line);
    }
    
    js = compressedLines.join('\n');

    // 3. 将 CSS 注入 HTML
    console.log('💉 注入 CSS 样式表...');
    const styleLinkRegex = /<link\s+rel=["']stylesheet["']\s+href=["']styles\.css["']\s*\/?>/i;
    if (styleLinkRegex.test(html)) {
        html = html.replace(styleLinkRegex, `<style>\n${css}\n</style>`);
    } else {
        // 如果没找到引用，默认放在 </head> 之前
        html = html.replace('</head>', `<style>\n${css}\n</style>\n</head>`);
    }

    // 4. 将 JS 注入 HTML 
    console.log('💉 注入 JavaScript 代码...');
    const scriptSrcRegex = /<script\s+src=["']app\.js["']\s*><\/script>/i;
    if (scriptSrcRegex.test(html)) {
        html = html.replace(scriptSrcRegex, `<script>\n${js}\n</script>`);
    } else {
        // 如果没找到，默认放在 </body> 之前
        html = html.replace('</body>', `<script>\n${js}\n</script>\n</body>`);
    }

    // 保存至 dist
    const distPath = path.join(distDir, 'index_bundled.html');
    fs.writeFileSync(distPath, html, 'utf8');
    
    // 全自动复制并重命名覆盖根目录下的 index.html (专门用于 GitHub Pages 部署)
    const rootIndexPath = path.join(__dirname, '..', 'index.html');
    fs.writeFileSync(rootIndexPath, html, 'utf8');
    
    console.log('====================================================');
    console.log('🎉 单文件打包圆满成功！');
    console.log(`📂 已导出至: dist/index_bundled.html`);
    console.log(`🔄 已同步覆盖至根目录: ../index.html (GitHub Pages 入口)`);
    console.log(`📈 原拆分文件总体积: ~${Math.round((css.length + js.length + html.length) / 1024)} KB`);
    console.log(`📉 打包单文件后体积: ~${Math.round(html.length / 1024)} KB`);
    console.log('====================================================');

} catch (e) {
    console.error('❌ 打包失败:', e);
}
