import { getMatchList } from '../../utils/api.js'

Page({
  data: {
    matchList: [],
    loading: false,
    lastUpdateTime: '',
    useRealData: true  // 默认使用真实数据
  },

  onLoad() {
    // 清除旧缓存，确保使用最新数据
    wx.removeStorageSync('matchList')
    wx.removeStorageSync('lastUpdateTime')
    this.loadMatchList()
  },

  onShow() {
    // 页面显示时检查是否需要更新数据（超过5分钟自动刷新）
    if (this.data.lastUpdateTime) {
      const now = Date.now()
      const lastTime = new Date(this.data.lastUpdateTime).getTime()
      if (now - lastTime > 5 * 60 * 1000) {
        this.loadMatchList()
      }
    }
  },

  onPullDownRefresh() {
    this.loadMatchList()
    setTimeout(() => {
      wx.stopPullDownRefresh()
    }, 1000)
  },

  // 加载比赛列表
  loadMatchList() {
    this.setData({ loading: true })

    if (this.data.useRealData) {
      // 使用真实API数据
      this.loadRealMatchList()
    } else {
      // 使用模拟数据
      this.loadMockMatchList()
    }
  },

  // 加载真实数据
  loadRealMatchList() {
    console.log('开始加载真实数据...')
    getMatchList()
      .then(data => {
        console.log('收到云函数数据:', data)
        const formattedList = this.formatMatchList(data)
        // 按开始时间排序（最近的在前）
        const sortedList = formattedList.sort((a, b) => {
          return new Date(a.startDate) - new Date(b.startDate)
        })
        console.log('排序后的数据:', sortedList)
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
        wx.showToast({
          title: '加载失败，使用本地数据',
          icon: 'none'
        })
        // 失败时使用缓存数据
        const cachedList = wx.getStorageSync('matchList')
        if (cachedList && cachedList.length > 0) {
          console.log('使用缓存数据:', cachedList)
          this.setData({
            matchList: cachedList,
            loading: false
          })
        } else {
          console.log('没有缓存数据，使用模拟数据')
          this.loadMockMatchList()
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

  // 跳转到详情页
  goDetail(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({
      url: `/pages/detail/detail?id=${id}`
    })
  },

  // 格式化比赛列表数据
  formatMatchList(data) {
    console.log('开始格式化数据，原始数据:', data)
    // 根据实际API返回的数据结构进行格式化
    if (Array.isArray(data)) {
      return data.map(item => ({
        id: item.id || item._id,
        name: item.name || item.tournament_name,
        startDate: item.startDate || item.start_date,
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

  // 模拟数据（仅作为后备方案）
  getMockMatchList() {
    const data = [
      {
        id: '1',
        name: '2026 Cazoo World Snooker Championship',
        startDate: '2026-04-19',
        endDate: '2026-05-05',
        location: 'Crucible Theatre, Sheffield, UK',
        prize: '£500,000'
      },
      {
        id: '2',
        name: '2026 China Open',
        startDate: '2026-03-24',
        endDate: '2026-03-30',
        location: 'Beijing, China',
        prize: '£225,000'
      },
      {
        id: '3',
        name: '2026 BetVictor German Masters',
        startDate: '2026-02-02',
        endDate: '2026-02-08',
        location: 'Tempodrom, Berlin, Germany',
        prize: '£80,000'
      },
      {
        id: '4',
        name: '2026 BetVictor Welsh Open',
        startDate: '2026-02-23',
        endDate: '2026-03-01',
        location: 'Venue Cymru, Llandudno, Wales',
        prize: '£80,000'
      },
      {
        id: '5',
        name: '2026 Players Championship',
        startDate: '2026-03-17',
        endDate: '2026-03-23',
        location: 'Telford International Centre, UK',
        prize: '£385,000'
      },
      {
        id: '6',
        name: '2025 Cazoo UK Championship',
        startDate: '2025-11-25',
        endDate: '2025-12-08',
        location: 'York Barbican, York, UK',
        prize: '£250,000'
      },
      {
        id: '7',
        name: '2026 British Open',
        startDate: '2026-09-22',
        endDate: '2026-09-28',
        location: 'The Centaur, Cheltenham, UK',
        prize: '£101,000'
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
