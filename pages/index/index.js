import { getMatchList } from '../../utils/api.js'

Page({
  data: {
    matchList: [],
    loading: false,
    lastUpdateTime: '',
    useRealData: true,  // 默认使用真实数据
    activeTab: 'all'    // 当前激活的选项卡：'all'（全部比赛）或 'main'（主要赛事）
  },

  onLoad() {
    // 生产环境：简单加载比赛列表
    this.loadMatchList()
  },

  onShow() {
    // 页面显示时检查是否需要更新数据（超过5分钟自动刷新）
    const now = Date.now()
    const lastTime = new Date(this.data.lastUpdateTime).getTime()

    // 如果没有上次更新时间，或者超过5分钟，则刷新
    if (!lastTime || (now - lastTime > 5 * 60 * 1000)) {
      this.loadMatchList()
    }
  },

  onPullDownRefresh() {
    // 下拉刷新时，先清空数据并加载最新数据
    this.setData({
      matchList: [],
      loading: true
    })
    this.loadMatchList()
    setTimeout(() => {
      wx.stopPullDownRefresh()
    }, 1000)
  },

  // 加载比赛列表
  loadMatchList() {
    // 先尝试从缓存加载数据，提升用户体验
    const cachedList = wx.getStorageSync('matchList')
    const cachedTime = wx.getStorageSync('lastUpdateTime')
    
    // 检查缓存数据是否有效
    let validCache = false
    if (cachedList && cachedList.length > 0) {
      // 缓存有效性检查：确保缓存数据是数组且有一定数量（至少2个比赛）
      validCache = Array.isArray(cachedList) && cachedList.length >= 2
      console.log('缓存有效性检查:', {
        缓存数据量: cachedList.length,
        缓存有效: validCache,
        要求最少数量: 2
      })
    }

    if (validCache) {
      this.setData({
        matchList: cachedList,
        lastUpdateTime: cachedTime || new Date().toISOString(),
        loading: false
      })
      console.log('使用有效缓存数据')
    } else {
      // 缓存无效，清除缓存
      if (cachedList && cachedList.length > 0) {
        console.log('清除无效缓存数据')
        wx.removeStorageSync('matchList')
        wx.removeStorageSync('lastUpdateTime')
      }
      this.setData({ loading: true })
    }

    // 加载真实数据
    this.loadRealMatchList(cachedList, cachedTime, validCache, this.data.activeTab)
  },

  // 加载真实数据
  loadRealMatchList(cachedList, cachedTime, hasCache, tour = 'all') {
    console.log('开始加载真实数据，赛事类型:', tour)
    getMatchList(tour)
      .then(data => {
        console.log('收到云函数数据，长度:', data.length, '数据:', data)
        const formattedList = this.formatMatchList(data)
        
        // 按赛季顺序排序：斯诺克赛季从8月开始
        // 将比赛日期映射到赛季时间线：8月为赛季起点（第0个月），7月为赛季终点（第11个月）
        const getSeasonOrder = (dateStr) => {
          const date = new Date(dateStr)
          const year = date.getFullYear()
          const month = date.getMonth() + 1  // 1-12
          
          let seasonYear, seasonMonth
          if (month >= 8) {
            // 8月-12月：属于当前赛季早期
            seasonYear = year
            seasonMonth = month - 8  // 0-4 (8月=0, 12月=4)
          } else {
            // 1月-7月：属于当前赛季后期（实际是下一日历年的部分）
            seasonYear = year - 1
            seasonMonth = month + 4  // 5-11 (1月=5, 7月=11)
          }
          
          // 返回一个可排序的数字：赛季年份 * 100 + 赛季月份
          return seasonYear * 100 + seasonMonth
        }
        
        const sortedList = formattedList.sort((a, b) => {
          return getSeasonOrder(a.startDate) - getSeasonOrder(b.startDate)
        })
        // 调试：输出每个比赛的赛季顺序值
        console.log('排序后的数据（包含赛季顺序值）:', sortedList.map(item => ({
          name: item.name,
          startDate: item.startDate,
          seasonOrder: getSeasonOrder(item.startDate)
        })))
        console.log('排序后的数据:', sortedList)

        if (sortedList.length === 0) {
          console.warn('云函数返回的数据为空')
          throw new Error('暂无赛事数据')
        }

        this.setData({
          matchList: sortedList,
          loading: false,
          lastUpdateTime: new Date().toISOString()
        })

        // 缓存数据到本地
        wx.setStorageSync('matchList', sortedList)
        wx.setStorageSync('lastUpdateTime', new Date().toISOString())

        wx.showToast({
          title: '数据已更新',
          icon: 'success',
          duration: 1500
        })
      })
      .catch(err => {
        console.error('加载真实数据失败:', err)
        const errorMsg = err.message || err.errMsg || '未知错误'
        console.error('详细错误信息:', errorMsg)

        // 如果之前加载过缓存数据，就保持显示
        if (hasCache) {
          this.setData({
            loading: false,
            lastUpdateTime: cachedTime || new Date().toISOString()
          })
          wx.showToast({
            title: `网络异常: ${errorMsg.substring(0, 20)}`,
            icon: 'none',
            duration: 3000
          })
        } else {
          // 没有缓存数据，显示详细错误提示
          this.setData({
            loading: false,
            lastUpdateTime: new Date().toISOString()
          })
          wx.showToast({
            title: errorMsg.substring(0, 50),
            icon: 'none',
            duration: 4000
          })
        }
      })
  },

  // 加载模拟数据（作为后备方案）
  loadMockMatchList() {
    console.log('开始加载模拟数据...')
    setTimeout(() => {
      const matchList = this.getMockMatchList()
      console.log('模拟数据加载完成，matchList:', matchList)
      // 数据已在 getMockMatchList 中排序
      this.setData({
        matchList: matchList,
        loading: false,
        lastUpdateTime: new Date().toISOString()
      })
      wx.showToast({
        title: '使用演示数据',
        icon: 'none'
      })
    }, 500)
  },

  // 刷新数据
  refreshData() {
    wx.showLoading({ title: '刷新中...' })
    this.loadMatchList()
    setTimeout(() => {
      wx.hideLoading()
    }, 600)
  },
  
  // 强制刷新数据（长按触发）
  forceRefresh() {
    wx.showModal({
      title: '强制刷新',
      content: '强制刷新将从snooker.org API重新获取最新数据，可能会消耗更多时间。确定要强制刷新吗？',
      success: (res) => {
        if (res.confirm) {
          wx.showLoading({ title: '强制刷新中...' })
          console.log('开始强制刷新数据...')
          
          // 清除本地缓存，确保获取最新数据
          wx.removeStorageSync('matchList')
          wx.removeStorageSync('lastUpdateTime')
          
          // 调用云函数强制更新
          wx.cloud.callFunction({
            name: 'getSnookerMatches',
            data: { 
              action: 'update',
              tour: this.data.activeTab,
              force: true
            }
          }).then(res => {
            wx.hideLoading()
            console.log('强制更新结果:', res)
            if (res.result && res.result.success) {
              console.log('✅ 强制更新成功！')
              wx.showToast({
                title: '强制更新成功',
                icon: 'success',
                duration: 2000
              })
              // 更新成功后重新加载数据
              this.loadMatchList()
            } else {
              wx.showToast({
                title: '强制更新失败',
                icon: 'none',
                duration: 2000
              })
            }
          }).catch(err => {
            wx.hideLoading()
            console.error('强制更新失败:', err)
            wx.showToast({
              title: '强制更新失败',
              icon: 'none',
              duration: 2000
            })
          })
        }
      }
    })
  },

  // 强制初始化数据库（手动触发）
  forceInitializeDatabase() {
    wx.showLoading({ title: '初始化中...' })
    console.log('手动触发数据库初始化...')
    wx.cloud.callFunction({
      name: 'getSnookerMatches',
      data: { 
        action: 'update',
        tour: 'all',
        force: true
      }
    }).then(res => {
      wx.hideLoading()
      console.log('手动更新结果:', res)
      if (res.result && res.result.success) {
        console.log('✅ 数据库初始化成功！')
        wx.setStorageSync('databaseInitialized', true)
        wx.showToast({
          title: '数据库初始化成功',
          icon: 'success',
          duration: 2000
        })
        // 初始化成功后刷新页面数据
        this.loadMatchList()
      } else {
        wx.showToast({
          title: '初始化失败',
          icon: 'none',
          duration: 2000
        })
      }
    }).catch(err => {
      wx.hideLoading()
      console.error('初始化失败:', err)
      wx.showToast({
        title: '初始化失败',
        icon: 'none',
        duration: 2000
      })
    })
  },
  
  // 测试数据库查询性能
  testDatabasePerformance() {
    console.log('=== 开始数据库查询性能测试 ===')
    console.time('数据库查询')
    wx.cloud.callFunction({
      name: 'getSnookerMatches',
      data: { action: 'list', tour: 'all' }
    }).then(res => {
      console.timeEnd('数据库查询') // 预期：< 200ms
      console.log('二次查询数据:', res.result.data.length)
    }).catch(err => {
      console.error('性能测试失败:', err)
    })
  },
  
  // 跳转到详情页
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    })
  },

  // 切换赛事类型选项卡
  switchTab(e) {
    const tab = e.currentTarget.dataset.tab
    if (this.data.activeTab === tab) {
      return
    }
    this.setData({
      activeTab: tab,
      matchList: [],
      loading: true
    })
    this.loadMatchList()
  },

  // 格式化比赛列表数据
  formatMatchList(data) {
    console.log('开始格式化数据，原始数据:', data)
    // 根据实际API返回的数据结构进行格式化
    if (Array.isArray(data)) {
      console.log('数据数量:', data.length)
      
      // 日期格式化函数，确保YYYY-MM-DD格式且月份日期补零
      const formatDateStr = (dateStr) => {
        if (!dateStr) return ''
        // 如果已经是YYYY-MM-DD格式，检查是否需要补零
        if (typeof dateStr === 'string' && /^\d{4}-\d{1,2}-\d{1,2}$/.test(dateStr)) {
          const parts = dateStr.split('-')
          const year = parts[0]
          const month = parts[1].padStart(2, '0')
          const day = parts[2].padStart(2, '0')
          return `${year}-${month}-${day}`
        }
        // 尝试解析日期
        try {
          const date = new Date(dateStr)
          if (!isNaN(date.getTime())) {
            const year = date.getFullYear()
            const month = String(date.getMonth() + 1).padStart(2, '0')
            const day = String(date.getDate()).padStart(2, '0')
            return `${year}-${month}-${day}`
          }
        } catch (error) {
          console.error('日期解析失败:', error, dateStr)
        }
        return dateStr
      }
      
      return data.map(item => ({
        id: item.id || item._id,
        name: item.name || item.tournament_name,
        startDate: formatDateStr(item.startDate || item.start_date),
        location: item.location || item.venue,
        prize: item.prize || item.prize_fund,
        status: this.determineStatus(item.status || item.state),
        statusText: this.getStatusText(item.status || item.state)
      }))
    }
    console.log('数据不是数组，返回空数组')
    return []
  },

  // 确定比赛状态
  determineStatus(status) {
    if (!status) return 'upcoming'
    const s = status.toLowerCase()
    if (s.includes('ongoing') || s.includes('live') || s.includes('in progress')) {
      return 'ongoing'
    } else if (s.includes('finished') || s.includes('completed') || s.includes('ended')) {
      return 'finished'
    }
    return 'upcoming'
  },

  // 获取状态文本
  getStatusText(status) {
    if (status === 'ongoing') return '进行中'
    if (status === 'finished') return '已结束'
    return '即将开始'
  },

  // 根据日期自动判断比赛状态
  determineMatchStatus(startDate, endDate) {
    const now = new Date()
    const start = new Date(startDate)
    const end = endDate ? new Date(endDate) : new Date(startDate)

    // 假设比赛持续7天，如果没有结束日期
    const finalEndDate = endDate ? end : new Date(start.getTime() + 7 * 24 * 60 * 60 * 1000)

    console.log('===== 状态判断 =====')
    console.log('比赛名称:', startDate)
    console.log('开始日期:', start, start.toISOString())
    console.log('结束日期:', finalEndDate, finalEndDate.toISOString())
    console.log('当前日期:', now, now.toISOString())
    console.log('now < start:', now < start)
    console.log('now >= start && now <= finalEndDate:', now >= start && now <= finalEndDate)

    if (now < start) {
      console.log('结果: 即将开始')
      return 'upcoming'
    } else if (now >= start && now <= finalEndDate) {
      console.log('结果: 进行中')
      return 'ongoing'
    } else {
      console.log('结果: 已结束')
      return 'finished'
    }
  },

  // 模拟数据（仅作为后备方案，与云函数内置数据保持一致）
  getMockMatchList() {
    // 计算当前赛季（与云函数逻辑一致）
    const getCurrentSeason = () => {
      const now = new Date()
      // 8月之前（0-7月）视为上一赛季
      return now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear()
    }
    
    const seasonYear = getCurrentSeason()
    const nextSeasonYear = seasonYear + 1
    
    // 基于当前赛季的真实斯诺克赛事数据
    const data = [
      {
        id: `wst-world-championship-${seasonYear}`,
        name: `${nextSeasonYear} Cazoo World Snooker Championship`,
        startDate: `${nextSeasonYear}-04-18`,
        endDate: `${nextSeasonYear}-05-04`,
        location: 'Crucible Theatre, Sheffield, UK',
        prize: '£2,600,000'
      },
      {
        id: `wst-uk-championship-${seasonYear}`,
        name: `${seasonYear} Cazoo UK Championship`,
        startDate: `${seasonYear}-11-23`,
        endDate: `${seasonYear}-12-06`,
        location: 'York Barbican, York, UK',
        prize: '£1,300,000'
      },
      {
        id: `wst-masters-${nextSeasonYear}`, // 大师赛在次年1月
        name: `${nextSeasonYear} Masters`,
        startDate: `${nextSeasonYear}-01-11`,
        endDate: `${nextSeasonYear}-01-18`,
        location: 'Alexandra Palace, London, UK',
        prize: '£800,000'
      },
      {
        id: `wst-welsh-open-${seasonYear}`,
        name: `${seasonYear} BetVictor Welsh Open`,
        startDate: `${nextSeasonYear}-02-23`,
        endDate: `${nextSeasonYear}-03-01`,
        location: 'Venue Cymru, Llandudno, Wales',
        prize: '£90,000'
      },
      {
        id: `wst-players-championship-${seasonYear}`,
        name: `${seasonYear} Players Championship`,
        startDate: `${nextSeasonYear}-03-16`,
        endDate: `${nextSeasonYear}-03-22`,
        location: 'Telford International Centre, UK',
        prize: '£400,000'
      },
      {
        id: `wst-tour-championship-${seasonYear}`,
        name: `${seasonYear} Tour Championship`,
        startDate: `${nextSeasonYear}-03-30`,
        endDate: `${nextSeasonYear}-04-05`,
        location: 'Venue Cymru, Llandudno, Wales',
        prize: '£400,000'
      },
      {
        id: `wst-shanghai-masters-${seasonYear}`,
        name: `${seasonYear} Shanghai Masters`,
        startDate: `${seasonYear}-09-14`,
        endDate: `${seasonYear}-09-20`,
        location: 'Shanghai, China',
        prize: '£900,000'
      },
      {
        id: `wst-china-open-${seasonYear}`,
        name: `${seasonYear} China Open`,
        startDate: `${nextSeasonYear}-03-23`,
        endDate: `${nextSeasonYear}-03-29`,
        location: 'Beijing, China',
        prize: '£275,000'
      },
      {
        id: `wst-german-masters-${seasonYear}`,
        name: `${seasonYear} BetVictor German Masters`,
        startDate: `${nextSeasonYear}-02-01`,
        endDate: `${nextSeasonYear}-02-07`,
        location: 'Tempodrom, Berlin, Germany',
        prize: '£90,000'
      },
      {
        id: `wst-british-open-${seasonYear}`,
        name: `${seasonYear} British Open`,
        startDate: `${seasonYear}-09-22`,
        endDate: `${seasonYear}-09-28`,
        location: 'The Centaur, Cheltenham, UK',
        prize: '£110,000'
      }
    ]

    // 根据实际日期自动判断状态
    return data.map(item => {
      const status = this.determineMatchStatus(item.startDate, item.endDate)
      return {
        ...item,
        status: status,
        statusText: this.getStatusText(status)
      }
    }).sort((a, b) => {
      return new Date(a.startDate) - new Date(b.startDate)
    })
  }
})
