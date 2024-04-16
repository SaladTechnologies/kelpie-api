export function error(status: number, body: any) {
    return new Response(JSON.stringify(body), { status });
}