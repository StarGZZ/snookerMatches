App({
  onLaunch() {
    console.log('App启动，初始化云开发...')
    wx.cloud.init({
      env: 'cloud1-1gchaeh24b6113fd',
      traceUser: true
    })
    console.log('云开发初始化完成，环境ID:', 'cloud1-1gchaeh24b6113fd')
  }
})
