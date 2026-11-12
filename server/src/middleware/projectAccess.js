import Project from '../models/Project.js';
import { canEditProject, canManageProjectMembers, canReadProject } from '../services/projectPermissions.js';

function validProjectId(id) { return /^[a-f\d]{24}$/i.test(id || ''); }

export async function requireProjectAccess(req,res,next){
  try{
    const id=req.params.projectId || req.params.id;
    if(!validProjectId(id)) return res.status(400).json({message:'Invalid project ID.'});
    const project=await Project.findById(id);
    if(!project) return res.status(404).json({message:'Project not found'});
    if(!canReadProject(project,req.user._id)) return res.status(403).json({message:'You do not have access to this project'});
    req.project=project; next();
  }catch(err){next(err);}
}

export function requireProjectEditor(req,res,next){
  if(!canEditProject(req.project,req.user._id)) return res.status(403).json({message:'Only project owners and editors can make project changes.'});
  return next();
}

export function requireProjectOwner(req,res,next){
  if(!canManageProjectMembers(req.project,req.user._id)) return res.status(403).json({message:'Only the project owner can manage members.'});
  return next();
}
