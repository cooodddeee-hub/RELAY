import mongoose from 'mongoose';
const schema=new mongoose.Schema({project:{type:mongoose.Schema.Types.ObjectId,ref:'Project',required:true,index:true},version:{type:Number,required:true,min:1},reportContent:{type:mongoose.Schema.Types.Mixed,required:true},findingIds:[{type:mongoose.Schema.Types.ObjectId,ref:'Finding'}],approvalStatus:{type:String,enum:['draft','approved'],default:'draft'},createdBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true}},{timestamps:true});
export default mongoose.model('Handover',schema);
