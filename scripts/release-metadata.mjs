/** Public build identity only. Never accepts provider credentials or private data. */
export function sourceVersion(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['version', 'commit', 'dirty', 'sourceSha256', 'evaluatedModel'].includes(key))
    || value.version !== 1 || typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)
    || value.commit !== null && (typeof value.commit !== 'string' || !/^[a-f0-9]{40}$/.test(value.commit))
    || typeof value.dirty !== 'boolean'
    || value.evaluatedModel !== null && (typeof value.evaluatedModel !== 'string' || !/^claude-[a-z0-9-]{1,90}$/.test(value.evaluatedModel))) {
    throw new Error('Invalid public source version metadata; build stopped without displaying its contents.')
  }
  return { version: 1, commit: value.commit, dirty: value.dirty, sourceSha256: value.sourceSha256, evaluatedModel: value.evaluatedModel }
}
