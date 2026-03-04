import { getMatchDetail, getMatchSchedule } from '../../utils/api.js'

Page({
  data: {
    match: {},
    dateTabs: [],
    activeDate: '',
    currentSchedule: [],
    autoRefresh: false,
    lastUpdateTime: '',
    refreshTimer: null,
    useRealData: true
  },

  onLoad(options) {
    const id = options.id
    this.loadMatchDetail(id)
  },

  onUnload() {
    // 清除定时器
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
    }
  },

  // 加载比赛详情
  loadMatchDetail(id) {
    wx.showLoading({ title: '加载中...' })

    if (this.data.useRealData) {
      // 使用真实API数据
      this.loadRealMatchDetail(id)
    } else {
      // 使用模拟数据
      this.loadMockMatchDetail(id)
    }
  },

  // 加载真实比赛详情
  loadRealMatchDetail(id) {
    console.log('加载比赛详情，ID:', id)
    getMatchDetail(id)
      .then(data => {
        console.log('收到比赛详情数据:', data)
        const match = this.formatMatchDetail(data)
        console.log('格式化后的比赛信息:', match)

        const dateTabs = this.generateDateTabs(match.startDate, match.endDate)
        console.log('生成的日期选项卡:', dateTabs)
        console.log('第一个日期选项卡:', dateTabs[0])

        this.setData({
          match: match,
          dateTabs: dateTabs,
          activeDate: dateTabs[0]?.date || ''
        })

        console.log('设置后的数据状态:', {
          match: this.data.match,
          dateTabs: this.data.dateTabs,
          activeDate: this.data.activeDate
        })

        // 缓存比赛详情数据
        wx.setStorageSync(`matchDetail-${id}`, match)
        console.log('比赛详情已缓存')

        if (dateTabs[0]?.date) {
          this.loadScheduleByDate(dateTabs[0].date)
        }
        wx.setNavigationBarTitle({ title: match.name || '比赛详情' })
        wx.hideLoading()
      })
      .catch(err => {
        console.error('加载比赛详情失败:', err)
        wx.hideLoading()
        
        // 尝试从缓存中加载比赛详情
        const cachedMatch = wx.getStorageSync(`matchDetail-${id}`)
        if (cachedMatch) {
          console.log('使用缓存的比赛详情数据')
          const dateTabs = this.generateDateTabs(cachedMatch.startDate, cachedMatch.endDate)
          this.setData({
            match: cachedMatch,
            dateTabs: dateTabs,
            activeDate: dateTabs[0]?.date || ''
          })
          wx.showToast({
            title: '使用缓存数据，可能不是最新',
            icon: 'none',
            duration: 3000
          })
          if (dateTabs[0]?.date) {
            this.loadScheduleByDate(dateTabs[0].date)
          }
        } else {
          wx.showToast({
            title: '获取真实数据失败: ' + (err.message || '请检查网络连接'),
            icon: 'none',
            duration: 3000
          })
          // 不再使用模拟数据，保持页面空白或显示错误状态
          this.setData({
            match: { name: '数据加载失败' },
            dateTabs: [],
            currentSchedule: []
          })
        }
      })
  },

  // 加载模拟比赛详情
  loadMockMatchDetail(id) {
    setTimeout(() => {
      const matchData = this.getMockMatchData(id)
      const dateTabs = this.generateDateTabs(matchData.startDate, matchData.endDate)

      this.setData({
        match: matchData,
        dateTabs: dateTabs,
        activeDate: dateTabs[0].date
      })

      this.loadScheduleByDate(dateTabs[0].date)
      wx.hideLoading()
    }, 300)
  },

  // 格式化比赛详情数据
  formatMatchDetail(data) {
    console.log('格式化比赛详情:', data)
    
    // 提取原始字段
    const rawId = data.id || data._id || data.ID
    const rawName = data.name || data.tournament_name || data.Name || ''
    const rawStartDate = data.startDate || data.start_date || data.StartDate
    const rawEndDate = data.endDate || data.end_date || data.EndDate
    const rawLocation = data.location || data.venue || data.Venue || ''
    const rawPrize = data.prize || data.prize_fund || data.PrizeFund || ''
    const rawStatus = data.status || data.state
    
    // 格式化日期，去掉时间部分
    const formatDateString = (dateStr) => {
      if (!dateStr) return ''
      // 如果是ISO格式（包含T），只取日期部分
      if (typeof dateStr === 'string' && dateStr.includes('T')) {
        return dateStr.split('T')[0]
      }
      // 如果是其他格式的日期字符串，尝试解析
      if (typeof dateStr === 'string') {
        const date = new Date(dateStr)
        if (!isNaN(date.getTime())) {
          return this.formatDate(date)
        }
      }
      return dateStr
    }
    
    return {
      id: rawId,
      name: rawName,
      startDate: formatDateString(rawStartDate),
      endDate: formatDateString(rawEndDate),
      location: rawLocation,
      prize: rawPrize,
      status: this.determineStatus(rawStatus),
      statusText: this.getStatusText(rawStatus)
    }
  },

  // 生成日期选项卡（覆盖整个比赛周期）
  generateDateTabs(startDate, endDate) {
    console.log('生成日期选项卡，开始日期:', startDate, '结束日期:', endDate)
    
    const tabs = []
    const weekDays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

    // 确保日期字符串格式正确
    const parseDate = (dateStr) => {
      if (!dateStr) {
        console.warn('日期字符串为空，使用当前日期')
        return new Date()
      }
      
      // 如果是ISO格式（包含T），直接解析
      if (typeof dateStr === 'string' && dateStr.includes('T')) {
        const date = new Date(dateStr)
        if (!isNaN(date.getTime())) return date
      }
      
      // 如果是YYYY-MM-DD格式
      if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
        const date = new Date(dateStr + 'T00:00:00')
        if (!isNaN(date.getTime())) return date
      }
      
      // 尝试直接解析
      const date = new Date(dateStr)
      if (!isNaN(date.getTime())) return date
      
      console.warn('无法解析日期:', dateStr, '使用当前日期')
      return new Date()
    }

    const start = parseDate(startDate)
    const end = endDate ? parseDate(endDate) : new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000) // 默认7天

    // 验证日期有效性
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      console.error('开始或结束日期无效，使用默认日期范围')
      const now = new Date()
      const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const defaultEnd = new Date(defaultStart.getTime() + 6 * 24 * 60 * 60 * 1000)
      return this.generateDefaultDateTabs(defaultStart, defaultEnd, weekDays)
    }

    // 确保结束日期不早于开始日期
    const effectiveEnd = end >= start ? end : new Date(start.getTime() + 6 * 24 * 60 * 60 * 1000)

    // 防止异常日期导致无限增长，最多生成 40 天
    const dayMs = 24 * 60 * 60 * 1000
    const maxDays = 40
    const totalDays = Math.min(maxDays, Math.max(1, Math.round((effectiveEnd - start) / dayMs) + 1))

    console.log('生成日期范围:', totalDays, '天，从', start.toISOString(), '到', effectiveEnd.toISOString())

    for (let i = 0; i < totalDays; i++) {
      const date = new Date(start.getTime() + i * dayMs)
      
      // 确保日期有效
      if (isNaN(date.getTime())) {
        console.error('生成无效日期，跳过')
        continue
      }

      const formattedDate = this.formatDate(date)
      if (!formattedDate) {
        console.error('格式化日期失败，跳过')
        continue
      }

      tabs.push({
        date: formattedDate,
        day: weekDays[date.getDay()]
      })
    }

    // 如果没有任何选项卡，生成默认的
    if (tabs.length === 0) {
      console.log('没有生成任何选项卡，使用默认值')
      const now = new Date()
      const defaultStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      const defaultEnd = new Date(defaultStart.getTime() + 6 * 24 * 60 * 60 * 1000)
      return this.generateDefaultDateTabs(defaultStart, defaultEnd, weekDays)
    }

    console.log('生成的日期选项卡:', tabs)
    return tabs
  },

  // 生成默认日期选项卡（当数据无效时使用）
  generateDefaultDateTabs(start, end, weekDays) {
    const tabs = []
    const dayMs = 24 * 60 * 60 * 1000
    const totalDays = Math.max(1, Math.round((end - start) / dayMs) + 1)
    
    for (let i = 0; i < Math.min(totalDays, 7); i++) {
      const date = new Date(start.getTime() + i * dayMs)
      tabs.push({
        date: this.formatDate(date),
        day: weekDays[date.getDay()]
      })
    }
    
    console.log('生成的默认日期选项卡:', tabs)
    return tabs
  },

  // 选择日期
  selectDate(e) {
    const date = e.currentTarget.dataset.date
    this.setData({ activeDate: date })
    this.loadScheduleByDate(date)
  },

  // 加载指定日期的比赛日程
  loadScheduleByDate(date) {
    wx.showLoading({ title: '加载中...' })

    if (this.data.useRealData) {
      // 使用真实API数据
      this.loadRealSchedule(date)
    } else {
      // 使用模拟数据
      this.loadMockSchedule(date)
    }
  },

  // 加载真实日程数据
  loadRealSchedule(date) {
    console.log('加载真实日程数据，比赛ID:', this.data.match.id, '日期:', date)
    getMatchSchedule(this.data.match.id, date)
      .then(data => {
        console.log('收到日程数据:', data)
        const schedule = this.formatSchedule(data)
        console.log('格式化后的日程:', schedule)
        this.setData({
          currentSchedule: schedule,
          lastUpdateTime: this.formatTime(new Date())
        })
        // 缓存赛程数据
        if (this.data.match.id) {
          wx.setStorageSync(`schedule-${this.data.match.id}-${date}`, schedule)
          console.log('赛程数据已缓存')
        }
        wx.hideLoading()
      })
      .catch(err => {
        console.error('加载日程失败:', err)
        wx.hideLoading()
        
        // 尝试从缓存中加载赛程数据
        if (this.data.match.id) {
          const cachedSchedule = wx.getStorageSync(`schedule-${this.data.match.id}-${date}`)
          if (cachedSchedule && cachedSchedule.length > 0) {
            console.log('使用缓存的赛程数据')
            this.setData({
              currentSchedule: cachedSchedule,
              lastUpdateTime: this.formatTime(new Date())
            })
            wx.showToast({
              title: '使用缓存赛程数据',
              icon: 'none',
              duration: 3000
            })
            return
          }
        }
        
        // 没有缓存数据，显示错误
        wx.showToast({
          title: '获取赛程失败: ' + (err.message || '请检查网络连接'),
          icon: 'none',
          duration: 3000
        })
        // 不再使用模拟数据，显示空赛程
        this.setData({
          currentSchedule: [],
          lastUpdateTime: this.formatTime(new Date())
        })
      })
  },

  // 加载模拟日程数据
  loadMockSchedule(date) {
    setTimeout(() => {
      const schedule = this.getMockSchedule(date)
      this.setData({
        currentSchedule: schedule,
        lastUpdateTime: this.formatTime(new Date())
      })
      wx.hideLoading()
    }, 300)
  },

  // 格式化日程数据
  formatSchedule(data) {
    if (!Array.isArray(data)) return []

    return data.map(item => ({
      id: item.id || item.match_id,
      time: item.time || item.start_time,
      player1: item.player1 || item.player_1 || item.playerA,
      player2: item.player2 || item.player_2 || item.playerB,
      score1: item.score1 || item.score_1 || item.frameA,
      score2: item.score2 || item.score_2 || item.frameB,
      round: item.round || item.stage,
      status: this.determineMatchStatus(item.status || item.state),
      statusText: this.getMatchStatusText(item.status || item.state)
    }))
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
    if (!status) return '即将开始'
    const s = status.toLowerCase()
    if (s.includes('ongoing') || s.includes('live')) return '进行中'
    if (s.includes('finished') || s.includes('completed')) return '已结束'
    return '即将开始'
  },

  // 确定单场比赛状态
  determineMatchStatus(status) {
    if (!status) return 'upcoming'
    const s = status.toLowerCase()
    if (s.includes('ongoing') || s.includes('live') || s.includes('playing')) {
      return 'ongoing'
    } else if (s.includes('finished') || s.includes('completed') || s.includes('ended')) {
      return 'finished'
    }
    return 'upcoming'
  },

  // 获取单场比赛状态文本
  getMatchStatusText(status) {
    if (!status) return '未开始'
    const s = status.toLowerCase()
    if (s.includes('ongoing') || s.includes('live')) return '进行中'
    if (s.includes('finished') || s.includes('completed')) return '已结束'
    return '未开始'
  },

  // 切换自动刷新
  toggleAutoRefresh() {
    const autoRefresh = !this.data.autoRefresh

    if (autoRefresh) {
      this.startRealTimeUpdates()
      wx.showToast({
        title: '已开启实时更新',
        icon: 'success'
      })
    } else {
      if (this.data.refreshTimer) {
        clearInterval(this.data.refreshTimer)
        this.setData({ refreshTimer: null })
      }
      wx.showToast({
        title: '已关闭实时更新',
        icon: 'none'
      })
    }

    this.setData({ autoRefresh })
  },

  // 开启实时更新（建议不要太频繁，避免触发数据源限流）
  startRealTimeUpdates() {
    if (this.data.refreshTimer) {
      clearInterval(this.data.refreshTimer)
    }

    const timer = setInterval(() => {
      this.loadScheduleByDate(this.data.activeDate)
    }, 120000)

    this.setData({ refreshTimer: timer })
  },

  // 下拉刷新
  onPullDownRefresh() {
    this.loadScheduleByDate(this.data.activeDate)
    setTimeout(() => {
      wx.stopPullDownRefresh()
    }, 1000)
  },

  // 格式化日期
  formatDate(date) {
    try {
      if (!(date instanceof Date) || isNaN(date.getTime())) {
        console.error('无效的日期对象:', date)
        return ''
      }
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${year}-${month}-${day}`
    } catch (error) {
      console.error('格式化日期失败:', error, date)
      return ''
    }
  },

  // 格式化时间
  formatTime(date) {
    const hours = String(date.getHours()).padStart(2, '0')
    const minutes = String(date.getMinutes()).padStart(2, '0')
    const seconds = String(date.getSeconds()).padStart(2, '0')
    return `${hours}:${minutes}:${seconds}`
  },

  // 模拟比赛详情数据
  getMockMatchData(id) {
    const matches = {
      '1': {
        id: '1',
        name: '2026世界斯诺克锦标赛',
        startDate: '2026-04-20',
        endDate: '2026-05-06',
        location: '谢菲尔德，英国',
        prize: '£500,000',
        status: 'ongoing',
        statusText: '进行中'
      },
      '2': {
        id: '2',
        name: '2026中国公开赛',
        startDate: '2026-03-15',
        endDate: '2026-03-21',
        location: '北京，中国',
        prize: '£225,000',
        status: 'upcoming',
        statusText: '即将开始'
      },
      '3': {
        id: '3',
        name: '2026德国大师赛',
        startDate: '2026-02-01',
        endDate: '2026-02-07',
        location: '柏林，德国',
        prize: '£80,000',
        status: 'finished',
        statusText: '已结束'
      },
      '4': {
        id: '4',
        name: '2026威尔士公开赛',
        startDate: '2026-02-15',
        endDate: '2026-02-21',
        location: '兰迪德诺，威尔士',
        prize: '£80,000',
        status: 'upcoming',
        statusText: '即将开始'
      },
      '5': {
        id: '5',
        name: '2026英国锦标赛',
        startDate: '2026-11-25',
        endDate: '2026-12-08',
        location: '约克，英国',
        prize: '£250,000',
        status: 'upcoming',
        statusText: '即将开始'
      }
    }
    return matches[id] || matches['1']
  },

  // 模拟比赛日程数据
  getMockSchedule(date) {
    // 随机生成一些比赛
    const schedules = []
    const rounds = ['第一轮', '第二轮', '四分之一决赛', '半决赛', '决赛']
    const players = ['Ronnie O\'Sullivan', 'Judd Trump', 'Neil Robertson', 'Mark Selby', 'Kyren Wilson', 'Ding Junhui', 'Mark Allen', 'John Higgins']

    const numMatches = Math.floor(Math.random() * 6) + 2

    for (let i = 0; i < numMatches; i++) {
      const status = Math.random() > 0.5 ? 'ongoing' : 'upcoming'
      const player1Idx = Math.floor(Math.random() * players.length)
      let player2Idx = Math.floor(Math.random() * players.length)
      while (player2Idx === player1Idx) {
        player2Idx = Math.floor(Math.random() * players.length)
      }

      schedules.push({
        id: `${date}-${i}`,
        time: `${String(9 + i * 2).padStart(2, '0')}:00`,
        player1: players[player1Idx],
        player2: players[player2Idx],
        score1: status === 'ongoing' ? Math.floor(Math.random() * 5) + 1 : '-',
        score2: status === 'ongoing' ? Math.floor(Math.random() * 5) : '-',
        round: rounds[Math.floor(Math.random() * rounds.length)],
        status: status,
        statusText: status === 'ongoing' ? '进行中' : '未开始'
      })
    }

    return schedules
  }
})
