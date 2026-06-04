const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

console.log('========================================================');
console.log('  Loris Auto-Compiler and GitHub Pages Deployer (JS)');
console.log('========================================================\n');

try {
    // 1. Run modular code packaging (build.js)
    console.log('[1/3] Running modular code packaging...');
    // Clear cache of build.js if required, then execute it
    delete require.cache[require.resolve('./build.js')];
    require('./build.js');
    console.log('');

    // 2. Get GitHub config from local Git
    console.log('[2/3] Checking Git remote configuration...');
    let repoUrl = '';
    try {
        repoUrl = execSync('git config --get remote.origin.url').toString().trim();
    } catch (e) {
        console.error('⚠️ 未能在本地 Git 仓库中检测到 remote origin URL。');
        process.exit(1);
    }
    
    let gitName = 'Loris Deployer';
    try {
        gitName = execSync('git config --get user.name').toString().trim() || gitName;
    } catch (_) {}

    let gitEmail = 'deployer@loris.local';
    try {
        gitEmail = execSync('git config --get user.email').toString().trim() || gitEmail;
    } catch (_) {}
    
    console.log(`[SUCCESS] 检测到绑定的远程仓库: ${repoUrl}`);
    console.log(`[IDENTITY] 部署提交身份: ${gitName} <${gitEmail}>\n`);

    // 3. Double-Track Isolated Deployment (Only push index.html)
    console.log('[3/3] Committing and pushing index.html to GitHub Pages...\n');
    console.log('Creating secure isolated environment...');

    const tempDeployDir = path.join(__dirname, 'temp_deploy');
    if (fs.existsSync(tempDeployDir)) {
        fs.rmSync(tempDeployDir, { recursive: true, force: true });
    }
    fs.mkdirSync(tempDeployDir);

    // Copy index.html and .gitignore (to let GitHub Pages know what to ignore online if any)
    fs.copyFileSync(path.join(__dirname, 'index.html'), path.join(tempDeployDir, 'index.html'));

    // Create a mini .gitignore in temp_deploy just to be complete
    fs.writeFileSync(path.join(tempDeployDir, '.gitignore'), '# GitHub Pages isolation\ntemp_deploy/\n', 'utf8');

    // Exec git commands in tempDeployDir
    const runGit = (cmd) => {
        execSync(cmd, { cwd: tempDeployDir, stdio: 'inherit' });
    };

    runGit('git init');
    runGit(`git remote add origin "${repoUrl}"`);
    runGit(`git config user.name "${gitName}"`);
    runGit(`git config user.email "${gitEmail}"`);
    runGit('git add index.html .gitignore');
    runGit('git commit -m "Auto-deploy production: compiled storage parallelization, dynamic paths, and visual unity"');
    runGit('git branch -M main');

    console.log('\nPushing changes securely to GitHub Pages branch (main)...');
    runGit('git push -f origin main');

    // Clean up
    try {
        fs.rmSync(tempDeployDir, { recursive: true, force: true });
    } catch (_) {}

    console.log('\n========================================================');
    console.log('  🎉 DEPLOYMENT COMPLETED SUCCESSFULLY!');
    console.log('  All development files are 100% SECURE on your computer!');
    console.log('  Only index.html was uploaded to your GitHub Pages!');
    console.log('========================================================\n');

} catch (error) {
    console.error('\n[ERROR] Deployment failed:', error.message);
    process.exit(1);
}
