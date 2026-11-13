import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
export async function extractTextFromBuffer(buffer, originalName){
  const ext=path.extname(originalName).toLowerCase();
  if(!Buffer.isBuffer(buffer)) throw new TypeError('Document content must be provided as a buffer.');
  if(ext==='.txt'||ext==='.md') return buffer.toString('utf8');
  if(ext==='.pdf'){const data=await pdf(buffer);return data.text;}
  if(ext==='.docx'){const data=await mammoth.extractRawText({buffer});return data.value;}
  throw new Error('Unsupported file type. Use PDF, DOCX, TXT or MD.');
}

export async function extractText(file){
  return extractTextFromBuffer(await fs.readFile(file.path), file.originalname);
}
