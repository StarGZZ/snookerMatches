import { getMatchList } from '../../utils/api.js'

Page({
  data: {
    matchList: [],
    loading: false,
    lastUpdateTime: '',
    dataSource: 'snooker.org', // 数据来源
    useRealData: true,  // 默认使用真实数据
    activeTab: 'all'    // 当前激活的选项卡：'all'（全部比赛）或 'main'（主要赛事）
  },

  onLoad() {
    this.loadMatchList()
  },

  onShow() {
    const now = Date.now()
    const lastTime = new Date(this.data.lastUpdateTime).getTime()
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
    // 先重置数据源，避免旧缓存影响
    this.setData({
      dataSource: 'snooker.org'  // 默认值
    })
    
    // 先尝试从缓存加载数据，提升用户体验
    const cachedList = wx.getStorageSync('matchList')
    const cachedTime = wx.getStorageSync('lastUpdateTime')
    
    // 检查缓存数据是否有效
    let validCache = false
    if (cachedList && cachedList.length > 0) {
      // 缓存有效性检查：确保缓存数据是数组且有一定数量（至少2个比赛）
      validCache = Array.isArray(cachedList) && cachedList.length >= 2

    }

    if (validCache) {
      // 格式化缓存时间
      const formattedCacheTime = this.formatTime(cachedTime || new Date().toISOString())
      
      this.setData({
        matchList: cachedList,
        lastUpdateTime: formattedCacheTime,
        loading: false,
        dataSource: 'local_cache'  // 标记为本地缓存
      })

    } else {
      // 缓存无效，清除缓存
      if (cachedList && cachedList.length > 0) {

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

    
    getMatchList(tour)
      .then(result => {

        
        const matchArray = result.data || []
        
        if (matchArray.length === 0) {
        }
        
        const formattedList = this.formatMatchList(matchArray)
        
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


        
        if (sortedList.length === 0) {

          // 如果云函数返回空数据，但有缓存数据，使用缓存数据
          if (hasCache && cachedList && cachedList.length > 0) {

            const formattedCacheTime = this.formatTime(cachedTime || new Date().toISOString())
            
            this.setData({
              matchList: cachedList,
              loading: false,
              lastUpdateTime: formattedCacheTime,
              dataSource: 'local_cache'
            })
            wx.showToast({
              title: '使用缓存数据',
              icon: 'none',
              duration: 2000
            })
            return
          }
          
          // 如果没有缓存数据，使用模拟数据

          this.loadMockMatchList()
          return
        }


        const lastUpdateTime = result.lastUpdate || new Date().toISOString()

        
        // 格式化时间
        const formattedTime = this.formatTime(lastUpdateTime)

        
        this.setData({
          matchList: sortedList,
          loading: false,
          lastUpdateTime: formattedTime,  // 直接使用格式化后的字符串
          dataSource: result.source || 'snooker.org'
        })
        

        
        // 缓存数据到本地
        wx.setStorageSync('matchList', sortedList)
        // 使用云函数返回的实际更新时间，不要覆盖为当前时间
        wx.setStorageSync('lastUpdateTime', result.lastUpdate)
        


        wx.showToast({
          title: '数据已更新',
          icon: 'success',
          duration: 1500
        })
      })
      .catch(err => {
        const errorMsg = err.message || err.errMsg || '未知错误'

        // 如果之前加载过缓存数据，就保持显示
        if (hasCache) {
          // 确保缓存数据仍然显示
          // 优先使用云函数返回的时间，其次使用缓存时间
          const updateTime = result.lastUpdate || cachedTime || new Date().toISOString()
          const formattedCacheTime = this.formatTime(updateTime)
          
          this.setData({
            loading: false,
            lastUpdateTime: formattedCacheTime,
            dataSource: 'local_cache'  // 标记为本地缓存
            // matchList 已经在 loadMatchList 中设置，这里不需要重复设置
          })
          wx.showToast({
            title: `网络异常，使用缓存数据: ${errorMsg.substring(0, 20)}`,
            icon: 'none',
            duration: 3000
          })
        } else {
          // 没有缓存数据，显示详细错误提示
          // 使用云函数返回的时间（如果有），否则使用当前时间
          const updateTime = result.lastUpdate || new Date().toISOString()
          const formattedTime = this.formatTime(updateTime)
          
          this.setData({
            loading: false,
            lastUpdateTime: formattedTime,
            dataSource: 'error_fallback'  // 标记为错误回退
          })
          wx.showToast({
            title: errorMsg.substring(0, 50),
            icon: 'none',
            duration: 4000
          })
          
          // 如果既没有缓存数据，也没有API数据，尝试使用模拟数据

          this.loadMockMatchList()
        }
      })
  },

  // 加载模拟数据（作为后备方案）
  loadMockMatchList() {

    const matchList = this.getMockMatchList()

    // 数据已在 getMockMatchList 中排序
    // 使用固定的演示数据时间，避免每次都显示当前时间
    const demoTime = new Date('2026-03-08T14:49:52.000Z').toISOString()
    const formattedTime = this.formatTime(demoTime)

    this.setData({
      matchList: matchList,
      loading: false,
      lastUpdateTime: formattedTime,
      dataSource: 'mock_data'  // 标记为模拟数据
    })

    wx.showToast({
      title: '使用演示数据',
      icon: 'none'
    })
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

            if (res.result && res.result.success) {

              const updateResult = res.result.data


              // 检查是否有实际的数据
              if (updateResult && updateResult.data && Array.isArray(updateResult.data)) {
                // 有比赛数据，使用这个数据
                const formattedList = this.formatMatchList(updateResult.data)
                const formattedTime = this.formatTime(updateResult.lastUpdate || new Date().toISOString())
                this.setData({
                  matchList: formattedList,
                  loading: false,
                  lastUpdateTime: formattedTime,
                  dataSource: updateResult.source || 'snooker.org'
                })
                // 缓存数据
                wx.setStorageSync('matchList', formattedList)
                wx.setStorageSync('lastUpdateTime', updateResult.lastUpdate || new Date().toISOString())
                wx.showToast({
                  title: '数据已更新',
                  icon: 'success',
                  duration: 2000
                })
              } else {
                // 没有比赛数据，重新加载列表

                this.loadMatchList()
              }
            } else {
              wx.showToast({
                title: '强制更新失败',
                icon: 'none',
                duration: 2000
              })
            }
          }).catch(() => {
            wx.hideLoading()

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

    // 根据实际API返回的数据结构进行格式化
    if (Array.isArray(data)) {

      
      // 日期格式化函数，确保YYYY-MM-DD格式且月份日期补零
      const formatDateStr = (dateStr) => {
        if (!dateStr) {

          return ''
        }
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

        }

        return dateStr
      }
      
      const formatted = data.map((item) => {

        const formattedItem = {
          id: item.id || item._id,
          name: item.name || item.tournament_name,
          startDate: formatDateStr(item.startDate || item.start_date),
          location: item.location || item.venue,
          prize: item.prize || item.prize_fund,
          status: this.determineStatus(item.status || item.state),
          statusText: this.getStatusText(item.status || item.state)
        }

        return formattedItem
      })

      return formatted
    }

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



    if (now < start) {

      return 'upcoming'
    } else if (now >= start && now <= finalEndDate) {

      return 'ongoing'
    } else {

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
  },

  // 格式化时间显示
  formatTime(isoString) {
    if (!isoString) {
      return '未知时间'
    }
    
    try {
      const date = new Date(isoString)
      if (isNaN(date.getTime())) {
        return '未知时间'
      }
      
      // 格式化为本地日期时间，例如 "2025-03-07 15:30:22"
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hours = String(date.getHours()).padStart(2, '0')
      const minutes = String(date.getMinutes()).padStart(2, '0')
      const seconds = String(date.getSeconds()).padStart(2, '0')
      return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`
    } catch (error) {

      return '未知时间'
    }
  }

})
