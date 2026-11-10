import { recordHandledFailure, classifyFailure } from './observability';

export function error(status: number, body: any) {
    if (status >= 400 && (status >= 500 || classifyFailure(body?.message) !== 'application_error')) {
        recordHandledFailure(body?.message);
    }
    return new Response(JSON.stringify(body), { status });
}
