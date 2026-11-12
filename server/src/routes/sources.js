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
const r=Router();r.use(requireAuth);
const uploadDir=path.resolve('uploads');await fs.mkdir(uploadDir,{recursive:true});
const storage=multer.diskStorage({destination:(_req,_file,cb)=>cb(null,uploadDir),filename:(_req,file,cb)=>cb(null,`${Date.now()}-${Math.round(Math.random()*1e9)}${path.extname(file.originalname).toLowerCase()}`)});
const upload=multer({storage,limits:{fileSize:15*1024*1024},fileFilter:(_req,file,cb)=>{const ext=path.extname(file.originalname).toLowerCase();cb(['.pdf','.docx','.txt','.md'].includes(ext)?null:new Error('Only PDF, DOCX, TXT and MD files are accepted'),['.pdf','.docx','.txt','.md'].includes(ext));}});
r.post('/projects/:id/sources',requireProjectAccess,requireProjectEditor,upload.single('file'),async(req,res,next)=>{let source;try{
 if(!req.file)return res.status(400).json({message:'Choose a document to upload'});
 source=await Source.create({project:req.project._id,originalName:req.file.originalname,mimeType:req.file.mimetype,size:req.file.size,storagePath:req.file.path,uploadedBy:req.user._id,status:'processing'});
 source.extractedText=await extractText(req.file);source.status='processed';await source.save();
 res.status(201).json({source:{_id:source.id,originalName:source.originalName,status:source.status,extractedCharacters:source.extractedText.length}});
}catch(e){if(source){source.status='failed';source.error=e.message;await source.save();}next(e)}});
r.get('/projects/:id/sources',requireProjectAccess,async(req,res,next)=>{try{const sources=await Source.find({project:req.project._id}).select('-extractedText -storagePath');res.json({sources})}catch(e){next(e)}});
async function authorizedSource(req,res,write=false){
 const source=await Source.findById(req.params.sourceId);
 if(!source){res.status(404).json({message:'Source not found'});return null;}
 const project=await Project.findById(source.project).select('owner members');
 if(!project||!canReadProject(project,req.user._id)){res.status(403).json({message:'Access denied'});return null;}
 if(write&&!canEditProject(project,req.user._id)){res.status(403).json({message:'Only project owners and editors can delete sources.'});return null;}
 return source;
}
r.get('/sources/:sourceId/content',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;if(source.status!=='processed')return res.status(409).json({message:'Source text is not available because processing has not completed.'});res.json({source:{_id:source.id,originalName:source.originalName,mimeType:source.mimeType,size:source.size,extractedText:source.extractedText||''}})}catch(e){next(e)}});
r.get('/sources/:sourceId/download',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;res.download(source.storagePath,path.basename(source.originalName),error=>{if(error&&!res.headersSent)next(error);});}catch(e){next(e)}});
r.get('/sources/:sourceId',async(req,res,next)=>{try{const source=await authorizedSource(req,res);if(!source)return;res.json({source:{_id:source.id,project:source.project,originalName:source.originalName,mimeType:source.mimeType,size:source.size,status:source.status,extractedText:source.extractedText,uploadedBy:source.uploadedBy,createdAt:source.createdAt,updatedAt:source.updatedAt}})}catch(e){next(e)}});
r.delete('/sources/:sourceId',async(req,res,next)=>{try{const source=await authorizedSource(req,res,true);if(!source)return;await fs.unlink(source.storagePath).catch(()=>{});await source.deleteOne();res.json({message:'Source deleted'})}catch(e){next(e)}});
export default r;
