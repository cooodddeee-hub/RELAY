import mongoose from 'mongoose';
const schema=new mongoose.Schema({project:{type:mongoose.Schema.Types.ObjectId,ref:'Project',required:true,index:true,immutable:true},version:{type:Number,required:true,min:1,immutable:true},reportContent:{type:mongoose.Schema.Types.Mixed,required:true,immutable:true},findingIds:{type:[{type:mongoose.Schema.Types.ObjectId,ref:'Finding'}],immutable:true},approvalStatus:{type:String,enum:['draft','pending','approved','rejected'],default:'draft'},createdBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true,immutable:true}},{timestamps:true});
schema.index({ project: 1, version: 1 }, { unique: true });
export default mongoose.model('Handover',schema);
