import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import mammoth from 'mammoth';
export async function extractText(file){
  const ext=path.extname(file.originalname).toLowerCase();
  if(ext==='.txt'||ext==='.md') return fs.readFile(file.path,'utf8');
  if(ext==='.pdf'){const data=await pdf(await fs.readFile(file.path));return data.text;}
  if(ext==='.docx'){const data=await mammoth.extractRawText({path:file.path});return data.value;}
  throw new Error('Unsupported file type. Use PDF, DOCX, TXT or MD.');
}
