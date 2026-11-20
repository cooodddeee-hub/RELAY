import {Router} from 'express';
import mongoose from 'mongoose';
import Project from '../models/Project.js';
import ProjectAssignment from '../models/ProjectAssignment.js';
import AuditEvent from '../models/AuditEvent.js';
import User from '../models/User.js';
import {requireAuth} from '../middleware/auth.js';
import {requireProjectAccess,requireProjectEditor,requireProjectOwner} from '../middleware/projectAccess.js';
import {normalizeMemberEmail,prepareMemberAddition,prepareMemberRemoval,prepareMemberRoleChange,validateMemberRole,visibleProjectsFilter} from '../services/projectMembership.js';
import {appendAuditEvent} from '../services/auditEvents.js';
import ProjectDeletionJob from '../models/ProjectDeletionJob.js';
import {cancelProjectDeletion, requestProjectDeletion, PROJECT_DELETION_RECOVERY_MS} from '../services/projectDeletion.js';
const r=Router();r.use(requireAuth);
r.get('/',async(req,res,next)=>{try{res.json({projects:await Project.find(visibleProjectsFilter(req.user._id))})}catch(e){next(e)}});
r.post('/',async(req,res,next)=>{try{const {name,description=''}=req.body||{};if(!name)return res.status(400).json({message:'Project name is required'});const project=await Project.create({name,description,owner:req.user._id,members:[{user:req.user._id,role:'owner'}],workflowPolicy:{reviewMode:'assigned',signoffMode:'assigned'}});res.status(201).json({project})}catch(e){next(e)}});
r.get('/:id',requireProjectAccess,(req,res)=>res.json({project:req.project}));
r.put('/:id',requireProjectAccess,requireProjectEditor,async(req,res,next)=>{try{const project=await Project.findOneAndUpdate({_id:req.project._id,$and:[{$or:[{deletionState:'active'},{deletionState:{$exists:false}}]},{$or:[{owner:req.user._id},{members:{$elemMatch:{user:req.user._id,role:'editor'}}}]}]},{$set:{name:req.body.name??req.project.name,description:req.body.description??req.project.description,status:req.body.status??req.project.status}}, {new:true});if(!project)return res.status(410).json({message:'Project deletion has started; the change was not saved.'});return res.json({project})}catch(e){next(e)}});
r.delete('/:id',requireProjectAccess,requireProjectOwner,async(req,res,next)=>{try{const result=await requestProjectDeletion({projectId:req.project._id,actorId:req.user._id});return res.status(202).json({message:'Project access is frozen. Recovery is available for 30 days before cleanup.',deletion:{state:result.project.deletionState,requestedAt:result.project.deletionRequestedAt,recoveryEndsAt:new Date(result.project.deletionRequestedAt.getTime()+PROJECT_DELETION_RECOVERY_MS),jobId:result.job._id}})}catch(error){if(error.status)return res.status(error.status).json({message:error.message});if(error?.code==='RETENTION_CONFIGURATION_INVALID')return res.status(503).json({message:'Audit retention is not configured; deletion was not requested.'});return next(error)}});

r.get('/:id/deletion',async(req,res,next)=>{try{if(!validObjectId(req.params.id))return res.status(400).json({message:'Invalid project ID.'});const project=await Project.findOne({_id:req.params.id,owner:req.user._id}).select('deletionState deletionRequestedAt deletedAt').lean();if(!project)return res.status(404).json({message:'Project deletion request not found.'});const job=await ProjectDeletionJob.findOne({projectId:req.params.id}).select('status phase attemptCount lastErrorCode nextAttemptAt updatedAt').lean();return res.json({deletion:{...project,recoveryEndsAt:project.deletionRequestedAt?new Date(project.deletionRequestedAt.getTime()+PROJECT_DELETION_RECOVERY_MS):null,job}})}catch(error){return next(error)}});

r.post('/:id/deletion/cancel',async(req,res,next)=>{try{if(!validObjectId(req.params.id))return res.status(400).json({message:'Invalid project ID.'});const project=await cancelProjectDeletion({projectId:req.params.id,actorId:req.user._id});return res.json({message:'Project deletion was cancelled.',project:{id:String(project._id),deletionState:project.deletionState}})}catch(error){if(error.status)return res.status(error.status).json({message:error.message});if(error?.code==='RETENTION_CONFIGURATION_INVALID')return res.status(503).json({message:'Audit retention is not configured; recovery was not saved.'});return next(error)}});

const validObjectId=(id)=>/^[a-f\d]{24}$/i.test(id||'');
const memberProjection='name email';
r.get('/:id/members',requireProjectAccess,async(req,res,next)=>{
 try{
  const [project,owner]=await Promise.all([
   Project.findById(req.project._id).populate('members.user',memberProjection),
   User.findById(req.project.owner).select(memberProjection),
  ]);
  const members=[];
  if(owner) members.push({memberId:String(owner._id),user:{id:String(owner._id),name:owner.name,email:owner.email},role:'owner'});
  for(const membership of project.members||[]){
   const user=membership.user;
   if(!user||String(user._id)===String(req.project.owner)) continue;
   members.push({memberId:String(user._id),user:{id:String(user._id),name:user.name,email:user.email},role:membership.role||'viewer'});
  }
  return res.json({members,canManageMembers:String(req.project.owner)===String(req.user._id)});
 }catch(error){return next(error)}
});

r.post('/:id/members',requireProjectAccess,requireProjectOwner,async(req,res,next)=>{
 try{
  const email=normalizeMemberEmail(req.body?.email);
  const role=validateMemberRole(req.body?.role);
  const user=await User.findOne({email}).select(memberProjection);
  const addition=prepareMemberAddition(req.project,user,role);
  const updated=await Project.findOneAndUpdate(
   {_id:req.project._id,owner:req.user._id,'members.user':{$ne:addition.user},$or:[{deletionState:'active'},{deletionState:{$exists:false}}]},
   {$push:{members:addition}},
   {new:true},
  );
  if(!updated) return res.status(409).json({message:'This user is already a member of the project.'});
  return res.status(201).json({member:{memberId:String(user._id),user:{id:String(user._id),name:user.name,email:user.email},role}});
 }catch(error){return next(error)}
});

r.patch('/:id/members/:memberId',requireProjectAccess,requireProjectOwner,async(req,res,next)=>{
 try{
  if(!validObjectId(req.params.memberId)) return res.status(400).json({message:'Invalid member ID.'});
  const {role}=req.body||{};
  const membership=prepareMemberRoleChange(req.project,req.params.memberId,role);
  const updated=await Project.findOneAndUpdate(
   {_id:req.project._id,owner:req.user._id,'members.user':membership.user,$or:[{deletionState:'active'},{deletionState:{$exists:false}}]},
   {$set:{'members.$.role':membership.role}},
   {new:true},
  );
  if(!updated) return res.status(404).json({message:'Member not found in this project.'});
  const user=await User.findById(req.params.memberId).select(memberProjection);
  if(!user) return res.status(404).json({message:'Member account was not found.'});
  return res.json({member:{memberId:String(user._id),user:{id:String(user._id),name:user.name,email:user.email},role}});
 }catch(error){return next(error)}
});

r.delete('/:id/members/:memberId',requireProjectAccess,requireProjectOwner,async(req,res,next)=>{
 try{
  if(!validObjectId(req.params.memberId)) return res.status(400).json({message:'Invalid member ID.'});
  const membership=prepareMemberRemoval(req.project,req.params.memberId);
  await Promise.all([ProjectAssignment.init(),AuditEvent.init()]);
  const session=await mongoose.startSession();
  try{
   await session.withTransaction(async()=>{
    const result=await Project.updateOne({_id:req.project._id,owner:req.user._id,'members.user':membership.user,$or:[{deletionState:'active'},{deletionState:{$exists:false}}]},{$pull:{members:{user:membership.user}}},{session});
    if(!result.modifiedCount) throw Object.assign(new Error('Member not found in this project.'),{status:404});
    const assignments=await ProjectAssignment.find({project:req.project._id,user:membership.user,status:'active'}).session(session);
    const now=new Date();
    if(assignments.length){
     await ProjectAssignment.updateMany({project:req.project._id,user:membership.user,status:'active'},{$set:{status:'revoked',revokedBy:req.user._id,revokedAt:now,revokeReason:'Project membership removed'}},{session});
    }
    await appendAuditEvent({projectId:req.project._id,actorId:req.user._id,action:'project_member.removed',targetType:'user',targetId:membership.user,session,now});
    for(const assignment of assignments){
     await appendAuditEvent({projectId:req.project._id,actorId:req.user._id,action:'assignment.revoked_by_member_removal',targetType:'project_assignment',targetId:assignment._id,scopeType:assignment.scopeType,scopeValue:assignment.scopeValue,reason:'Project membership removed',session,now});
    }
   });
  }finally{await session.endSession()}
  return res.json({message:'Member removed from project.'});
 }catch(error){if(error?.code==='RETENTION_CONFIGURATION_INVALID')return res.status(503).json({message:'Audit retention is not configured; the operation was not saved.'});return next(error)}
});
export default r;
