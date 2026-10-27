import { api } from "../_lib/core.js";
const handler = (request) => api(request, new URL(request.url));
export const GET = handler;
export const POST = handler;