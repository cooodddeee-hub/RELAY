import {Router} from 'express';
import Project from '../models/Project.js';
import User from '../models/User.js';
import {requireAuth} from '../middleware/auth.js';
import {requireProjectAccess,requireProjectEditor,requireProjectOwner} from '../middleware/projectAccess.js';
import {normalizeMemberEmail,prepareMemberAddition,prepareMemberRemoval,prepareMemberRoleChange,validateMemberRole,visibleProjectsFilter} from '../services/projectMembership.js';
const r=Router();r.use(requireAuth);
r.get('/',async(req,res,next)=>{try{res.json({projects:await Project.find(visibleProjectsFilter(req.user._id))})}catch(e){next(e)}});
r.post('/',async(req,res,next)=>{try{const {name,description=''}=req.body||{};if(!name)return res.status(400).json({message:'Project name is required'});const project=await Project.create({name,description,owner:req.user._id,members:[{user:req.user._id,role:'owner'}]});res.status(201).json({project})}catch(e){next(e)}});
r.get('/:id',requireProjectAccess,(req,res)=>res.json({project:req.project}));
r.put('/:id',requireProjectAccess,requireProjectEditor,async(req,res,next)=>{try{Object.assign(req.project,{name:req.body.name??req.project.name,description:req.body.description??req.project.description,status:req.body.status??req.project.status});await req.project.save();res.json({project:req.project})}catch(e){next(e)}});
r.delete('/:id',requireProjectAccess,requireProjectOwner,async(req,res,next)=>{try{await req.project.deleteOne();res.json({message:'Project deleted'})}catch(e){next(e)}});

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
   {_id:req.project._id,'members.user':{$ne:addition.user}},
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
   {_id:req.project._id,'members.user':membership.user},
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
  const result=await Project.updateOne({_id:req.project._id,'members.user':membership.user},{$pull:{members:{user:membership.user}}});
  if(!result.modifiedCount) return res.status(404).json({message:'Member not found in this project.'});
  return res.json({message:'Member removed from project.'});
 }catch(error){return next(error)}
});
export default r;
