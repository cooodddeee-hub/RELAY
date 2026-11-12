import mongoose from 'mongoose';
const schema=new mongoose.Schema({project:{type:mongoose.Schema.Types.ObjectId,ref:'Project',required:true},originalName:{type:String,required:true},mimeType:String,size:Number,storagePath:{type:String,required:true},extractedText:{type:String,default:''},status:{type:String,enum:['uploaded','processing','processed','failed'],default:'uploaded'},analysisCompletedAt:{type:Date,select:false},uploadedBy:{type:mongoose.Schema.Types.ObjectId,ref:'User',required:true},error:String},{timestamps:true});
export default mongoose.model('Source',schema);
