// @vitest-environment node
import { expect, it } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { validateDocument } from './files'
it('checks PDF pages and rejects unsupported bytes regardless of declared MIME', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage()
  expect((await validateDocument(await pdf.save())).mediaType).toBe('application/pdf')
  for (let i = 0; i < 10; i++) pdf.addPage()
  await expect(validateDocument(await pdf.save())).rejects.toThrow('1–10')
  await expect(validateDocument(new TextEncoder().encode('<script>not a document</script>'))).rejects.toThrow('Share a JPG')
})
