/**
 * 斯诺克赛事API工具类
 * 使用腾讯云云函数获取真实数据
 */

const cloud = wx.cloud
const CLOUD_FN_TIMEOUT = 8000

/**
 * 获取比赛列表
 */
export function getMatchList() {
  return new Promise((resolve, reject) => {
    console.log('开始调用云函数获取比赛列表...')
    cloud.callFunction({
      name: 'getSnookerMatches',
      timeout: CLOUD_FN_TIMEOUT,
      data: {
        action: 'list'
      }
    }).then(res => {
      console.log('云函数返回结果:', res)
      if (res.result && res.result.success) {
        resolve(res.result.data)
      } else {
        console.error('云函数返回失败:', res.result)
        reject(new Error(res.result.error || '云函数调用失败'))
      }
    }).catch(err => {
      console.error('获取比赛列表失败:', err)
      reject(err)
    })
  })
}

/**
 * 获取比赛详情
 */
export function getMatchDetail(id) {
  return new Promise((resolve, reject) => {
    console.log('开始调用云函数获取比赛详情, ID:', id)
    cloud.callFunction({
      name: 'getSnookerMatches',
      timeout: CLOUD_FN_TIMEOUT,
      data: {
        action: 'detail',
        id: id
      }
    }).then(res => {
      console.log('云函数返回结果:', res)
      if (res.result && res.result.success) {
        resolve(res.result.data)
      } else {
        console.error('云函数返回失败:', res.result)
        reject(new Error(res.result.error || '云函数调用失败'))
      }
    }).catch(err => {
      console.error('获取比赛详情失败:', err)
      reject(err)
    })
  })
}

/**
 * 获取指定日期的比赛日程
 */
export function getMatchSchedule(matchId, date) {
  return new Promise((resolve, reject) => {
    console.log('开始调用云函数获取比赛日程, matchId:', matchId, ', date:', date)
    cloud.callFunction({
      name: 'getSnookerMatches',
      timeout: CLOUD_FN_TIMEOUT,
      data: {
        action: 'schedule',
        matchId: matchId,
        date: date
      }
    }).then(res => {
      console.log('云函数返回结果:', res)
      if (res.result && res.result.success) {
        resolve(res.result.data)
      } else {
        console.error('云函数返回失败:', res.result)
        reject(new Error(res.result.error || '云函数调用失败'))
      }
    }).catch(err => {
      console.error('获取比赛日程失败:', err)
      reject(err)
    })
  })
}

/**
 * 直接调用外部API（不使用云函数）
 * 注意：需要在小程序管理后台配置合法域名
 */
const EXTERNAL_API = {
  // World Snooker Tour官方API（示例）
  WST_API: 'https://api.wst.tv/v1',

  // Cuetracker API（第三方斯诺克数据源）
  CUETRACKER_API: 'https://cuetracker.net/api'
}

/**
 * 从外部API获取比赛列表
 */
export function getMatchListFromExternal() {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${EXTERNAL_API.CUETRACKER_API}/tournaments`,
      method: 'GET',
      header: {
        'content-type': 'application/json'
      },
      success: (res) => {
        if (res.statusCode === 200) {
          resolve(res.data)
        } else {
          reject(new Error(`API请求失败: ${res.statusCode}`))
        }
      },
      fail: (err) => {
        console.error('外部API请求失败:', err)
        reject(err)
      }
    })
  })
}
