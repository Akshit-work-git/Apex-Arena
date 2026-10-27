import { api } from "./_lib/core.js";
export const GET = (request) => api(request, new URL(request.url));