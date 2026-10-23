export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 200,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': '*',
            },
        });
    }

    const hasBanana = !!(process.env.BANANA_TOKEN && process.env.BANANA_TOKEN.trim());
    const hasModelScope = !!(process.env.MODELSCOPE_TOKEN && process.env.MODELSCOPE_TOKEN.trim());

    const resHeaders = new Headers();
    resHeaders.set('Content-Type', 'application/json; charset=utf-8');
    resHeaders.set('Access-Control-Allow-Origin', '*');

    return new Response(JSON.stringify({
        hasBananaToken: hasBanana,
        hasModelScopeToken: hasModelScope
    }), {
        status: 200,
        headers: resHeaders,
    });
}
