import {Router} from 'express';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import Source from '../models/Source.js';
import Project from '../models/Project.js';
import {requireAuth} from '../middleware/auth.js';
import {requireProjectAccess,requireProjectEditor} from '../middleware/projectAccess.js';
import {canEditProject,canReadProject} from '../services/projectPermissions.js';
import {extractText} from '../services/documentText.js';
import {assertLocalSourceAvailable,deleteLocalSourceSafely,localDiskUploadDisabled,LocalSourceUnavailableError} from '../services/localSourceStorage.js';
import {getSupabaseStorage} from '../services/supabaseStorage.js';
import {assertSourceReadAccess,completeSourceUpload,createSourceDownloadUrl,createSourceUploadIntent,deleteSupabaseSource,SourceWorkflowError} from '../services/sourceStorageWorkflow.js';
const r=Router();r.use(requireAuth);
const localDiskUploadsEnabled=!localDiskUploadDisabled();
if(localDiskUploadsEnabled){
 const uploadDir=path.resolve('uploads');
 const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,uploadDir),filename:(_req,file,cb)=>cb(null,`${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname).toLowerCase()}`)});
 const upload=multer({storage,limits:{fileSize:15*1024*1024},fileFilter:(_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(['.pdf','.docx','.txt','.md'].includes(ext)?null:new Error('Only PDF, DOCX, TXT and MD files are accepted'),['.pdf','.docx','.txt','.md'].includes(ext));}});
 async function ensureUploadDirectory(_req,_res,next){try{await fs.mkdir(uploadDir,{recursive:true});next()}catch(error){next(error)}}
 r.post('/projects/:id/sources',requireProjectAccess,requireProjectEditor,ensureUploadDirectory,upload.single('file'),async(req,res,next)=>{let source;try{
  if(!req.file)return res.status(400).json({message:'Choose a document to upload'});
  source=await Source.create({project:req.project._id,originalName:req.file.originalname,mimeType:req.file.mimetype,size:req.file.size,storagePath:req.file.path,uploadedBy:req.user._id,status:'processing'});
  source.extractedText=await extractText(req.file);source.status='processed';await source.save();
  res.status(201).json({source:{_id:source.id,originalName:source.originalName,status:source.status,extractedCharacters:source.extractedText.length}});
 }catch(e){if(source){source.status='failed';source.error=e.message;await source.save();}next(e)}});
}else{
 r.post('/projects/:id/sources',requireProjectAccess,requireProjectEditor,(_req,res)=>res.status(410).json({message:'Local-disk uploads are disabled in production. Use the secure source upload workflow.'}));
}
r.post('/projects/:id/sources/upload-intent',requireProjectAccess,requireProjectEditor,async(req,res,next)=>{
 try{
  const configured=getSupabaseStorage();
  const result=await createSourceUploadIntent({project:req.project,user:req.user,metadata:req.body,storageConfig:configured});
  return res.status(201).json({source:{_id:result.source.id,originalName:result.source.originalName,mimeType:result.source.mimeType,size:result.source.size,status:result.source.status,uploadStatus:result.source.uploadStatus},uploadUrl:result.uploadUrl});
 }catch(error){if(error instanceof SourceWorkflowError||error?.status===503)return res.status(error.status).json({message:error.message});return next(error)}
});
r.post('/sources/:sourceId/complete',async(req,res,next)=>{
 try{
  if(!/^[a-f\d]{24}$/i.test(req.params.sourceId||''))return res.status(400).json({message:'Invalid source ID.'});
  const source=await Source.findById(req.params.sourceId);
  if(!source)return res.status(404).json({message:'Source upload intent not found.'});
  const project=await Project.findById(source.project).select('owner members');
  assertSourceReadAccess(project,req.user._id);
  const configured=getSupabaseStorage();
  const result=await completeSourceUpload({source,project,userId:req.user._id,storageConfig:configured});
  return res.json({source:{_id:result.source.id,originalName:result.source.originalName,status:result.source.status,uploadStatus:result.source.uploadStatus,extractedCharacters:result.source.extractedText.length},alreadyCompleted:result.alreadyCompleted});
 }catch(error){if(error instanceof SourceWorkflowError||error?.status===503)return res.status(error.status).json({message:error.message});return next(error)}
});
r.get('/projects/:id/sources',requireProjectAccess,async(req,res,next)=>{try{const sources=await Source.find({project:req.project._id,uploadStatus:{$nin:['pending','processing']}}).select('-extractedText -storagePath -storageKey');res.json({sources})}catch(e){next(e)}});
async function authorizedSource(req,res,write=false){
 const source=await Source.findById(req.params.sourceId);
 if(!source){res.status(404).json({message:'Source not found'});return null;}
 const project=await Project.findById(source.project).select('owner members');
 if(!project||!canReadProject(project,req.user._id)){res.status(403).json({message:'Access denied'});return null;}
 if(write&&!canEditProject(project,req.user._id)){res.status(403).json({message:'Only project owners and editors can delete sources.'});return null;}
 return source;
}
r.get('/sources/:sourceId/content',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;if(source.status!=='processed')return res.status(409).json({message:'Source text is not available because processing has not completed.'});res.json({source:{_id:source.id,originalName:source.originalName,mimeType:source.mimeType,size:source.size,extractedText:source.extractedText||''}})}catch(e){next(e)}});
r.get('/sources/:sourceId/download',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;if(source.storageProvider==='supabase'){const signedUrl=await createSourceDownloadUrl(source,{storageConfig:getSupabaseStorage()});return res.redirect(302,signedUrl);}await assertLocalSourceAvailable(source.storagePath);return res.download(source.storagePath,path.basename(source.originalName),error=>{if(error&&!res.headersSent)next(error);});}catch(e){if(e instanceof LocalSourceUnavailableError)return res.status(e.status).json({message:e.message});if(e instanceof SourceWorkflowError||e?.status===503)return res.status(e.status).json({message:e.message});next(e)}});
r.get('/sources/:sourceId',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;res.json({source:{_id:source.id,project:source.project,originalName:source.originalName,mimeType:source.mimeType,size:source.size,status:source.status,extractedText:source.extractedText,uploadedBy:source.uploadedBy,createdAt:source.createdAt,updatedAt:source.updatedAt}})}catch(e){next(e)}});
r.delete('/sources/:sourceId',async(req,res,next)=>{try{const source=await authorizedSource(req,res,true);if(!source)return;if(source.storageProvider==='supabase'){await deleteSupabaseSource(source,{storageConfig:getSupabaseStorage()});return res.json({message:'Source deleted'});}await deleteLocalSourceSafely(source);res.json({message:'Source deleted'})}catch(e){if(e instanceof LocalSourceUnavailableError)return res.status(e.status).json({message:e.message});if(e instanceof SourceWorkflowError||e?.status===503)return res.status(e.status).json({message:e.message});next(e)}});
export default r;
