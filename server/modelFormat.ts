import { z } from 'zod'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema'

type Schema = { type?: string | string[]; $ref?: string; properties?: Record<string, Schema>; additionalProperties?: Schema | boolean; propertyNames?: Schema; items?: Schema; anyOf?: Schema[]; oneOf?: Schema[]; const?: unknown; description?: string; [key: string]: unknown }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const nullableString = (node: Schema): Schema | undefined => {
  if (Array.isArray(node.type) && node.type.length === 2 && node.type.includes('string') && node.type.includes('null')) return node
  const variants = node.anyOf ?? node.oneOf
  return variants?.length === 2 && variants.some(item => item.type === 'null') ? variants.find(item => item.type === 'string') : undefined
}

const stringRecord = (node: Schema, resolve: (node: Schema) => Schema) => node.type === 'object' && !Object.keys(node.properties ?? {}).length && object(node.additionalProperties) && resolve(node.additionalProperties).type === 'string'
const reservedKey = (key: string) => ['__proto__', 'prototype', 'constructor'].includes(key)

/** Provider-only encoding: nullable strings use empty strings; dynamic string
 * records use key/value entries because strict objects cannot have dynamic keys.
 * Restore both before original Zod validation. Stored payloads/hashes stay intact.
 * https://platform.claude.com/docs/en/build-with-claude/structured-outputs
 */
export function modelFormat<S extends z.ZodType>(schema: S) {
  const format = zodOutputFormat(schema)
  const original = z.toJSONSchema(schema, { reused: 'ref' }) as Schema
  const wire = structuredClone(original)
  const compact = (node: Schema) => {
    if (stringRecord(node, resolve)) {
      const key = { type: 'string', ...node.propertyNames } as Schema
      const value = node.additionalProperties as Schema
      const description = `${node.description ?? ''} Represent this string dictionary as key/value entries. Use each key once; use [] when empty. For evidence, key is the field name and value is an exact source quote.`.trim()
      for (const name of Object.keys(node)) delete node[name]
      Object.assign(node, { type: 'array', description, items: { type: 'object', properties: { key, value }, required: ['key', 'value'], additionalProperties: false } })
    }
    const string = nullableString(node)
    if (string) {
      Object.assign(node, string)
      delete node.anyOf; delete node.oneOf
      node.type = 'string'
      node.description = `${node.description ?? ''} Use an empty string when unknown or not applicable; the application restores null.`.trim()
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(child => { if (object(child)) compact(child as Schema) })
      else if (object(value)) compact(value as Schema)
    }
  }
  compact(wire)
  function resolve(node: Schema): Schema {
    if (!node.$ref) return node
    if (!node.$ref.startsWith('#/')) throw new Error('External model schema references are unsupported.')
    let found: unknown = original
    for (const key of node.$ref.slice(2).split('/')) found = object(found) ? found[key.replace(/~1/g, '/').replace(/~0/g, '~')] : undefined
    if (!object(found)) throw new Error('Invalid model schema reference.')
    return found as Schema
  }
  const restore = (value: unknown, unresolved: Schema): unknown => {
    const node = resolve(unresolved)
    if (nullableString(node) && value === '') return null
    if (stringRecord(node, resolve)) {
      // Reject ambiguous or unsafe keys before reconstructing an object. Never
      // assign model-controlled keys onto an existing object's prototype chain.
      const entries: [string, string][] = [], seen = new Set<string>()
      const input = Array.isArray(value) ? value : object(value) ? Object.entries(value).map(([key, value]) => ({ key, value })) : null
      if (!input) throw new Error('String record entries must be an array or object.')
      for (const entry of input) {
        if (!object(entry) || Object.keys(entry).length !== 2 || typeof entry.key !== 'string' || typeof entry.value !== 'string' || reservedKey(entry.key) || seen.has(entry.key)) throw new Error('String record contains invalid or duplicate entries.')
        seen.add(entry.key); entries.push([entry.key, entry.value])
      }
      return Object.fromEntries(entries)
    }
    const variants = node.anyOf ?? node.oneOf
    if (variants && object(value)) {
      const branch = variants.map(resolve).find(candidate => candidate.properties?.kind?.const === value.kind && value.kind !== undefined)
      if (branch) return restore(value, branch)
    }
    if (Array.isArray(value) && node.items) return value.map(item => restore(item, node.items!))
    if (object(value) && node.properties) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, node.properties![key] ? restore(item, node.properties![key]) : item]))
    return value
  }
  // Transform after encoding: doing this first silently closes record objects,
  // leaving the model able to emit only {} for every evidence map.
  const encoded = jsonSchemaOutputFormat(wire as Parameters<typeof jsonSchemaOutputFormat>[0])
  return { ...format, schema: encoded.schema, parse: (content: string) => format.parse(JSON.stringify(restore(JSON.parse(content), original))) }
}
