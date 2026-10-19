import { httpRouter } from 'convex/server'
import { httpAction } from './_generated/server'
import { internal } from './_generated/api'
const http = httpRouter()
http.route({ path: '/google/callback', method: 'GET', handler: httpAction(async (ctx, request) => {
  const url = new URL(request.url)
  try {
    const returnTo = await ctx.runAction(internal.google.callback, { state: url.searchParams.get('state') ?? '', ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}) })
    return new Response(null, { status: 303, headers: { Location: returnTo, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  } catch {
    return new Response('Google connection could not be verified. Return to Daymark and reconnect. If Google created a calendar, check it before creating another.', { status: 400, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  }
}) })
http.route({ path: '/microsoft/callback', method: 'GET', handler: httpAction(async (ctx, request) => {
  const url = new URL(request.url)
  try {
    const returnTo = await ctx.runAction(internal.microsoft.callback, { state: url.searchParams.get('state') ?? '', ...(url.searchParams.get('code') ? { code: url.searchParams.get('code')! } : {}) })
    return new Response(null, { status: 303, headers: { Location: returnTo, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } })
  } catch { return new Response('Microsoft connection could not be verified. Return to Daymark and reconnect.', { status: 400, headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } }) }
}) })
export default http
const uploadHeaders = () => ({ 'Access-Control-Allow-Origin': process.env.DAYMARK_WEB_URL ?? '', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-File-Name', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin', 'Cache-Control': 'no-store' })
http.route({ path: '/intake/upload', method: 'OPTIONS', handler: httpAction(async (_ctx, request) => {
  const origin = request.headers.get('origin')
  if (origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403 })
  return new Response(null, { headers: { ...uploadHeaders(), 'Access-Control-Allow-Origin': origin } })
}) })
http.route({ path: '/intake/upload', method: 'POST', handler: httpAction(async (ctx, request) => {
  const origin = request.headers.get('origin')
  const headers = { ...uploadHeaders(), 'Access-Control-Allow-Origin': origin === 'capacitor://localhost' ? origin : process.env.DAYMARK_WEB_URL ?? '', 'Content-Type': 'application/json' }
  if (!await ctx.auth.getUserIdentity()) return new Response(JSON.stringify({ error: 'Sign in before uploading.' }), { status: 401, headers })
  if (origin && origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403, headers })
  if (Number(request.headers.get('content-length')) > 10 * 1024 * 1024) return new Response(JSON.stringify({ error: 'Share files up to 10 MB.' }), { status: 413, headers })
  const blob = await request.blob()
  if (blob.size > 10 * 1024 * 1024 || !blob.size) return new Response(JSON.stringify({ error: 'Share files up to 10 MB.' }), { status: 413, headers })
  const storageId = await ctx.storage.store(blob)
  try {
    const id = await ctx.runMutation(internal.intake.accepted, { storageId, name: decodeURIComponent(request.headers.get('x-file-name') ?? 'Shared document').replace(/[\r\n\x00]/g, '').slice(0, 200), size: blob.size, mediaType: blob.type })
    return new Response(JSON.stringify({ id }), { status: 201, headers })
  } catch { await ctx.storage.delete(storageId); return new Response(JSON.stringify({ error: 'Confirm your household before uploading.' }), { status: 400, headers }) }
}) })
http.route({ path: '/inbound/resend', method: 'POST', handler: httpAction(async (ctx, request) => {
  if (Number(request.headers.get('content-length')) > 100000) return new Response(null, { status: 413 })
  const raw = await request.text()
  if (raw.length > 100000) return new Response(null, { status: 413 })
  const accepted = await ctx.runAction(internal.forwarding.receive, { raw, id: request.headers.get('svix-id') ?? '', timestamp: request.headers.get('svix-timestamp') ?? '', signature: request.headers.get('svix-signature') ?? '' })
  return new Response(null, { status: accepted ? 204 : 400 })
}) })

http.route({ path: '/intake/file', method: 'OPTIONS', handler: httpAction(async (_ctx, request) => {
  const origin = request.headers.get('origin')
  if (origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403 })
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } })
}) })
http.route({ path: '/intake/file', method: 'GET', handler: httpAction(async (ctx, request) => {
  const origin = request.headers.get('origin')
  if (origin && origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403 })
  try {
    const id = new URL(request.url).searchParams.get('id') as import('./_generated/dataModel').Id<'attachments'>
    const file = await ctx.runQuery(internal.intake.readable, { id })
    const blob = file && await ctx.storage.get(file.storageId)
    if (!blob) return new Response(null, { status: 404 })
    return new Response(blob, { headers: { 'Content-Type': file!.mediaType, 'Cache-Control': 'no-store', 'Content-Security-Policy': "sandbox", 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': origin ?? process.env.DAYMARK_WEB_URL ?? '', Vary: 'Origin' } })
  } catch { return new Response(null, { status: 404 }) }
}) })

http.route({ path: '/library/file', method: 'OPTIONS', handler: httpAction(async (_ctx, request) => {
  const origin = request.headers.get('origin')
  if (origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403 })
  return new Response(null, { headers: { 'Access-Control-Allow-Origin': origin, 'Access-Control-Allow-Headers': 'Authorization', 'Access-Control-Allow-Methods': 'GET, OPTIONS', Vary: 'Origin' } })
}) })
http.route({ path: '/library/file', method: 'GET', handler: httpAction(async (ctx, request) => {
  const origin = request.headers.get('origin')
  if (origin && origin !== process.env.DAYMARK_WEB_URL && origin !== 'capacitor://localhost') return new Response(null, { status: 403 })
  try {
    const id = new URL(request.url).searchParams.get('id') as import('./_generated/dataModel').Id<'library'>
    const file = await ctx.runQuery(internal.library.readable, { id }), blob = file && await ctx.storage.get(file.storageId)
    if (!blob) return new Response(null, { status: 404 })
    return new Response(blob, { headers: { 'Content-Type': file!.mediaType ?? 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': 'sandbox', 'X-Content-Type-Options': 'nosniff', 'Access-Control-Allow-Origin': origin ?? process.env.DAYMARK_WEB_URL ?? '', Vary: 'Origin' } })
  } catch { return new Response(null, { status: 404 }) }
}) })
