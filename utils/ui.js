function error(e){wx.showToast({title:e && e.message || '操作未完成，请重试',icon:'none',duration:3000});}
function back(){if(getCurrentPages().length>1)wx.navigateBack();else wx.switchTab({url:'/pages/home/index'});}
module.exports={error,back};
