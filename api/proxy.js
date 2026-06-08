export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // CORS 预检请求处理
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS, PUT, PATCH, DELETE',
                'Access-Control-Allow-Headers': '*',
            },
        });
    }

    const targetUrlStr = req.headers.get('x-target-url');
    if (!targetUrlStr) {
        return new Response('Missing X-Target-URL header', { status: 400 });
    }

    try {
        const targetUrl = new URL(targetUrlStr);
        const headers = new Headers(req.headers);

        // 剔除不安全和不必要的请求头，保证代理顺畅
        headers.delete('host');
        headers.delete('x-target-url');
        headers.delete('connection');
        headers.delete('accept-encoding');

        // API 密钥自动安全注入逻辑：优先使用网页前端传来的 Auth，没有则用 Vercel 环境变量
        const targetHost = targetUrl.hostname;
        const hasAuth = headers.get('authorization') || headers.get('Authorization');
        if (!hasAuth) {
            const bananaToken = process.env.BANANA_TOKEN;
            const modelscopeToken = process.env.MODELSCOPE_TOKEN;

            if (targetHost.includes('modelscope.cn') && modelscopeToken) {
                headers.set('authorization', `Bearer ${modelscopeToken}`);
            } else if (bananaToken) {
                headers.set('authorization', `Bearer ${bananaToken}`);
            }
        }

        // 装配代理请求体
        const fetchOptions = {
            method: req.method,
            headers: headers,
        };

        // 对于带有 Body 的请求（非 GET / HEAD），流式传入请求体
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = req.body;
        }

        // 调用目标第三方 API
        const response = await fetch(targetUrl.toString(), fetchOptions);

        // 重新包装并加上跨域 CORS 支持头返回
        const resHeaders = new Headers(response.headers);
        resHeaders.set('Access-Control-Allow-Origin', '*');
        resHeaders.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
        resHeaders.set('Access-Control-Allow-Headers', '*');

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: resHeaders,
        });

    } catch (e) {
        return new Response(`Proxy Error: ${e.message}`, { status: 500 });
    }
}
