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
    this.loadMatchList(true) // 传递 forceUpdate=true 标记强制刷新
  },

  getCacheKeys(tour = this.data.activeTab) {
    return {
      listKey: `matchList_${tour}`,
      timeKey: `lastUpdateTime_${tour}`
    }
  },

  getCacheSnapshot(tour = this.data.activeTab) {
    const { listKey, timeKey } = this.getCacheKeys(tour)
    const list = wx.getStorageSync(listKey)
    const time = wx.getStorageSync(timeKey)
    const valid = Array.isArray(list) && list.length >= 2

    if (!valid && Array.isArray(list) && list.length > 0) {
      wx.removeStorageSync(listKey)
      wx.removeStorageSync(timeKey)
    }

    return {
      list,
      time,
      valid
    }
  },

  getFriendlyError(err) {
    const explicitType = err?.errorType
    const msg = err?.message || err?.errMsg || '未知错误'

    if (explicitType === 'timeout' || /timeout|超时|ECONNABORTED|TIMEOUT/i.test(msg)) {
      return { type: 'timeout', text: '网络超时' }
    }

    if (explicitType === 'service_unavailable' || /503|504|502|ERR_CANCELED|ENOTFOUND|service unavailable|服务不可用/i.test(msg)) {
      return { type: 'service_unavailable', text: '服务暂不可用' }
    }

    return { type: 'unknown', text: '刷新失败，请稍后重试' }
  },

  // 加载比赛列表
  loadMatchList(forceUpdate = false) {
    const tour = this.data.activeTab
    const cache = this.getCacheSnapshot(tour)

    this.setData({
      dataSource: 'snooker.org'
    })

    if (!forceUpdate && cache.valid) {
      this.setData({
        matchList: cache.list,
        lastUpdateTime: this.formatTime(cache.time || new Date().toISOString()),
        loading: false,
        dataSource: 'local_cache'
      })
    } else {
      this.setData({ loading: true })
    }

    return this.loadRealMatchList(cache.list, cache.time, cache.valid, tour, forceUpdate)
  },

  // 加载真实数据
  loadRealMatchList(cachedList, cachedTime, hasCache, tour = 'all', forceUpdate = false) {
    const { listKey, timeKey } = this.getCacheKeys(tour)

    return getMatchList(tour, forceUpdate)
      .then(result => {
        const matchArray = result.data || []
        const formattedList = this.formatMatchList(matchArray)

        // 按赛季顺序排序：斯诺克赛季从8月开始
        // 将比赛日期映射到赛季时间线：8月为赛季起点（第0个月），7月为赛季终点（第11个月）
        const getSeasonOrder = (dateStr) => {
          const date = new Date(dateStr)
          const year = date.getFullYear()
          const month = date.getMonth() + 1

          let seasonYear, seasonMonth
          if (month >= 8) {
            seasonYear = year
            seasonMonth = month - 8
          } else {
            seasonYear = year - 1
            seasonMonth = month + 4
          }

          return seasonYear * 100 + seasonMonth
        }

        const sortedList = formattedList.sort((a, b) => {
          return getSeasonOrder(a.startDate) - getSeasonOrder(b.startDate)
        })

        if (sortedList.length === 0) {
          if (hasCache && Array.isArray(cachedList) && cachedList.length > 0) {
            this.setData({
              matchList: cachedList,
              loading: false,
              lastUpdateTime: this.formatTime(cachedTime || new Date().toISOString()),
              dataSource: 'local_cache'
            })
            wx.showToast({
              title: '使用缓存数据',
              icon: 'none',
              duration: 2000
            })
            return
          }

          this.loadMockMatchList()
          return
        }

        const lastUpdateTime = result.lastUpdate || new Date().toISOString()
        const formattedTime = this.formatTime(lastUpdateTime)
        const dataSource = result.source || 'snooker.org'

        this.setData({
          matchList: sortedList,
          loading: false,
          lastUpdateTime: formattedTime,
          dataSource: dataSource
        })

        if (dataSource !== 'hardcoded_fallback') {
          wx.setStorageSync(listKey, sortedList)
          wx.setStorageSync(timeKey, lastUpdateTime)
        }

        const toastTitle = result.isFallback
          ? (result.message || '已显示最近有效数据')
          : (forceUpdate ? '强制刷新成功' : '数据已更新')

        wx.showToast({
          title: toastTitle,
          icon: result.isFallback ? 'none' : 'success',
          duration: 2000
        })
      })
      .catch(err => {
        const { text } = this.getFriendlyError(err)

        if (hasCache && Array.isArray(cachedList) && cachedList.length > 0) {
          this.setData({
            matchList: cachedList,
            loading: false,
            lastUpdateTime: this.formatTime(cachedTime || new Date().toISOString()),
            dataSource: 'local_cache'
          })
          wx.showToast({
            title: `${text}，已显示缓存`,
            icon: 'none',
            duration: 2500
          })
          return
        }

        this.setData({
          loading: false,
          lastUpdateTime: this.formatTime(new Date().toISOString()),
          dataSource: 'error_fallback'
        })
        this.loadMockMatchList(`${text}，显示演示数据`)
      })
      .finally(() => {
        wx.hideLoading()
        wx.stopPullDownRefresh()
      })
  },

  // 加载模拟数据（作为后备方案）
  loadMockMatchList(toastTitle = '使用演示数据') {
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
      title: toastTitle,
      icon: 'none'
    })
  },

  // 刷新数据
  refreshData() {
    wx.showLoading({ title: '刷新中...' })
    this.loadMatchList()
  },
  
  // 强制刷新数据（长按触发）
  forceRefresh() {
    wx.showModal({
      title: '强制刷新',
      content: '将直接从 snooker.org 获取最新数据；若超时会回退到最近有效数据。确定继续吗？',
      success: ({ confirm }) => {
        if (!confirm) {
          return
        }

        wx.showLoading({ title: '强制刷新中...' })
        this.loadMatchList(true)
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
