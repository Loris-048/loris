const { execSync } = require('child_process');

console.log('========================================================');
console.log('  Loris Auto-Compiler and GitHub Pages Deployer');
console.log('========================================================\n');

try {
    // 1. 运行本地打包编译 (build.js)
    console.log('[1/2] Running modular code packaging...');
    delete require.cache[require.resolve('./build.js')];
    require('./build.js');
    console.log('');

    // 2. 常规增量推送 index.html，绝对禁止强推，保护所有远程文件
    console.log('[2/2] Committing and pushing index.html to GitHub...\n');
    
    // 获取绑定的远程仓库 URL
    let repoUrl = '';
    try {
        repoUrl = execSync('git config --get remote.origin.url').toString().trim();
    } catch (e) {
        console.error('⚠️ 未能在本地 Git 仓库中检测到 remote origin URL。');
        process.exit(1);
    }
    console.log(`[SUCCESS] 检测到绑定的远程仓库: ${repoUrl}`);

    console.log('Staging compiled index.html...');
    execSync('git add index.html', { stdio: 'inherit' });
    
    try {
        console.log('Committing changes...');
        execSync('git commit -m "Deploy: update compiled index.html"', { stdio: 'inherit' });
    } catch (e) {
        console.log('ℹ️ 没有检测到 index.html 的变化，无需提交新 commit。');
    }

    console.log('Pushing to GitHub branch (main) safely...');
    execSync('git push origin main', { stdio: 'inherit' });

    console.log('\n========================================================');
    console.log('  🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
    console.log('  index.html has been safely compiled and pushed!');
    console.log('  Your other GitHub files are 100% PROTECTED!');
    console.log('========================================================\n');

} catch (error) {
    console.error('\n[ERROR] Deployment failed:', error.message);
    process.exit(1);
}
