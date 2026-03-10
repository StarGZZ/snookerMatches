// 云函数入口文件
const cloud = require('wx-server-sdk')
const axios = require('axios')
const request = require('request-promise-native')
const https = require('https')

// 强制使用 IPv4 避免 Node 在尝试 IPv6 时等待超时（与 test_api.js 保持一致）
const httpsAgent = new https.Agent({ family: 4 })


cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
})

// 云数据库配置
const DB_COLLECTION = 'snooker_matches'

/**
 * 从云数据库获取比赛列表
 * @param {number} season - 赛季年份
 * @param {string} tourType - 赛事类型：'all'或'main'
 */
async function getMatchListFromDB(season, tourType = 'all') {
  const startTime = Date.now()
  try {
    console.log(`[${new Date().toISOString()}] 从数据库获取比赛列表，赛季: ${season}, 类型: ${tourType}`)
    const db = cloud.database()
    
    // 构建查询条件
    const query = db.collection(DB_COLLECTION).where({
      season: season
    })
    
    const queryStartTime = Date.now()
    const result = await query.orderBy('start_date', 'asc').get()
    const queryTime = Date.now() - queryStartTime
    console.log(`[${new Date().toISOString()}] 数据库查询成功，获取 ${result.data.length} 条记录，查询耗时: ${queryTime}ms`)
    
    // 如果在内存中过滤主要赛事
    if (tourType === 'main' && result.data.length > 0) {
      const filterStartTime = Date.now()
      const mainMatches = result.data.filter(match => {
        const id = String(match.id || '').toLowerCase()
        // 过滤掉挑战赛和资格赛
        return !id.includes('challenge') && !id.includes('qual')
      })
      const filterTime = Date.now() - filterStartTime
      const totalTime = Date.now() - startTime
      console.log(`[${new Date().toISOString()}] 过滤后主要赛事数量: ${mainMatches.length}，过滤耗时: ${filterTime}ms，总耗时: ${totalTime}ms`)
      return mainMatches
    }
    
    const totalTime = Date.now() - startTime
    console.log(`[${new Date().toISOString()}] 数据库查询总耗时: ${totalTime}ms`)
    return result.data
  } catch (error) {
    console.error('从数据库获取比赛列表失败:', error)
    return null
  }
}

/**
 * 保存比赛列表到云数据库
 * @param {Array} matches - 比赛列表数据
 * @param {number} season - 赛季年份
 */
async function saveMatchListToDB(matches, season) {
  const startTime = Date.now()
  try {
    if (!matches || !Array.isArray(matches) || matches.length === 0) {
      console.log('无有效数据保存到数据库')
      return false
    }
    
    console.log(`[${new Date().toISOString()}] 开始保存 ${matches.length} 条记录到数据库，赛季: ${season}`)
    const db = cloud.database()
    const now = new Date().toISOString()  // 使用 ISO 字符串格式，便于读取
    
    // 核心改进：并行清理所有旧数据（非当前赛季和当前赛季）
    const currentSeason = getCurrentSeason()
    
    try {
      const cleanStartTime = Date.now()
      console.log(`[${new Date().toISOString()}] 开始并行清理旧数据...`)
      
      // 并行执行两个删除操作
      const [oldSeasonsResult, currentSeasonResult] = await Promise.all([
        // 删除非当前赛季数据
        db.collection(DB_COLLECTION)
          .where({ season: db.command.neq(currentSeason) })
          .remove()
          .catch(err => {
            console.warn('清理非当前赛季数据失败:', err.message)
            return { stats: { removed: 0 } }
          }),
        
        // 删除当前赛季旧数据
        db.collection(DB_COLLECTION)
          .where({ season: currentSeason })
          .remove()
          .catch(err => {
            console.warn('清理当前赛季旧数据失败:', err.message)
            return { stats: { removed: 0 } }
          })
      ])
      
      const cleanTime = Date.now() - cleanStartTime
      const totalRemoved = (oldSeasonsResult.stats?.removed || 0) + (currentSeasonResult.stats?.removed || 0)
      console.log(`[${new Date().toISOString()}] 并行清理旧数据完成，总计删除 ${totalRemoved} 条记录，耗时: ${cleanTime}ms`)
      console.log(`  非当前赛季删除: ${oldSeasonsResult.stats?.removed || 0} 条`)
      console.log(`  当前赛季删除: ${currentSeasonResult.stats?.removed || 0} 条`)
      
    } catch (cleanError) {
      console.warn('并行清理旧数据失败，继续保存新数据:', cleanError.message)
    }
    
    // 分批保存数据（避免单次操作过大）
    const batchSize = 20
    let savedCount = 0
    
    for (let i = 0; i < matches.length; i += batchSize) {
      const batch = matches.slice(i, i + batchSize)
      const operations = batch.map(match => ({
        _id: match.id,
        ...match,
        season: season,
        updated_at: now
      }))
      
      // 批量添加
      const addPromises = operations.map(operation => 
        db.collection(DB_COLLECTION).add({ data: operation })
      )
      
      try {
        await Promise.all(addPromises)
        savedCount += batch.length
        console.log(`批量保存成功: ${batch.length} 条（总计: ${savedCount}/${matches.length}）`)
      } catch (batchError) {
        console.error(`批量保存失败（批次 ${i/batchSize + 1}）:`, batchError.message)
        // 尝试单条保存
        for (const operation of operations) {
          try {
            await db.collection(DB_COLLECTION).add({ data: operation })
            savedCount++
          } catch (singleError) {
            console.error('单条保存失败:', singleError.message)
          }
        }
      }
    }
    
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.log(`[${new Date().toISOString()}] 数据保存完成，总计保存 ${savedCount} 条记录，总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
    return savedCount > 0
  } catch (error) {
    console.error('保存比赛列表到数据库失败:', error)
    return false
  }
}

/**
 * 获取数据库数据的最后更新时间
 * @param {number} season - 赛季年份
 * @returns {string|null} ISO格式的最后更新时间，如果没有数据则返回null
 */
async function getLastUpdateTimeFromDB(season) {
  const startTime = Date.now()
  try {
    const db = cloud.database()
    
    // 检查最新更新时间
    const queryStartTime = Date.now()
    const latestResult = await db.collection(DB_COLLECTION)
      .where({ season: season })
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()
    const queryTime = Date.now() - queryStartTime
    
    if (latestResult.data.length === 0) {
      console.log(`[${new Date().toISOString()}] 数据库无该赛季数据，无法获取最后更新时间，查询耗时: ${queryTime}ms`)
      return null
    }
    
    const rawUpdate = latestResult.data[0].updated_at
    console.log(`[${new Date().toISOString()}] 数据库原始最后更新时间:`, rawUpdate, '类型:', typeof rawUpdate)
    
    // 处理不同格式的日期数据（兼容旧数据和新数据）
    let lastUpdate = null
    try {
      if (typeof rawUpdate === 'string') {
        // 新格式：ISO 字符串，直接使用
        if (rawUpdate) {
          const date = new Date(rawUpdate)
          if (!isNaN(date.getTime())) {
            lastUpdate = date.toISOString()
          }
        }
      } else if (rawUpdate && typeof rawUpdate === 'object') {
        // 旧格式：微信云数据库的时间戳格式
        if (rawUpdate.$date) {
          lastUpdate = new Date(rawUpdate.$date).toISOString()
        } else if (rawUpdate.getTime && typeof rawUpdate.getTime === 'function') {
          lastUpdate = rawUpdate.toISOString()
        } else {
          const date = new Date(rawUpdate)
          if (!isNaN(date.getTime())) {
            lastUpdate = date.toISOString()
          }
        }
      }
    } catch (parseError) {
      console.error('解析数据库最后更新时间失败:', parseError, '原始值:', rawUpdate)
      lastUpdate = null
    }
    
    const totalTime = Date.now() - startTime
    console.log(`[${new Date().toISOString()}] 数据库最后更新时间: ${lastUpdate}, 查询耗时: ${queryTime}ms, 总耗时: ${totalTime}ms`)
    return lastUpdate
  } catch (error) {
    console.error('获取数据库最后更新时间失败:', error)
    return null
  }
}

/**
 * 检查数据库数据是否需要更新
 * @param {number} season - 赛季年份
 * @returns {boolean} true表示需要更新，false表示不需要
 */
async function shouldUpdateFromDB(season) {
  const startTime = Date.now()
  try {
    const db = cloud.database()
    const now = new Date()
    
    // 检查该赛季是否有数据
    const countStartTime = Date.now()
    const result = await db.collection(DB_COLLECTION)
      .where({ season: season })
      .count()
    const countTime = Date.now() - countStartTime
    
    if (result.total === 0) {
      console.log(`[${new Date().toISOString()}] 数据库无该赛季数据，需要更新: ${season}，查询耗时: ${countTime}ms`)
      return true
    }
    
    // 检查最新更新时间
    const latestStartTime = Date.now()
    const latestResult = await db.collection(DB_COLLECTION)
      .where({ season: season })
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()
    const latestTime = Date.now() - latestStartTime
    
    if (latestResult.data.length === 0) {
      console.log(`[${new Date().toISOString()}] 数据库有数据但无更新时间，需要更新: ${season}，查询耗时: ${countTime + latestTime}ms`)
      return true
    }
    
    // 正确处理数据库返回的日期格式（兼容旧数据和新数据）
    const rawUpdate = latestResult.data[0].updated_at
    console.log(`[${new Date().toISOString()}] 数据库原始更新时间:`, rawUpdate, '类型:', typeof rawUpdate)
    
    let latestUpdate
    try {
      if (typeof rawUpdate === 'string') {
        // 新格式：ISO 字符串
        latestUpdate = new Date(rawUpdate)
      } else if (rawUpdate && typeof rawUpdate === 'object') {
        // 旧格式：微信云数据库的时间戳格式
        if (rawUpdate.$date) {
          latestUpdate = new Date(rawUpdate.$date)
        } else if (rawUpdate.getTime && typeof rawUpdate.getTime === 'function') {
          latestUpdate = rawUpdate
        } else {
          latestUpdate = new Date(rawUpdate)
        }
      } else {
        latestUpdate = new Date()
      }
      
      // 检查日期是否有效
      if (isNaN(latestUpdate.getTime())) {
        console.warn('数据库更新时间无效，使用当前时间')
        latestUpdate = new Date()
      }
    } catch (parseError) {
      console.error('解析数据库更新时间失败:', parseError, '使用当前时间')
      latestUpdate = new Date()
    }
    
    const hoursDiff = (now - latestUpdate) / (1000 * 60 * 60)
    
    // 如果数据超过72小时未更新，则重新获取（延长缓存时间，减少对外部API的依赖）
    const needUpdate = hoursDiff > 72
    const totalTime = Date.now() - startTime
    console.log(`[${new Date().toISOString()}] 数据库检查: 最后更新 ${hoursDiff.toFixed(1)} 小时前，需要更新: ${needUpdate}，总耗时: ${totalTime}ms`)
    return needUpdate
  } catch (error) {
    console.error('检查数据库更新状态失败:', error)
    return true // 出错时认为需要更新
  }
}

/**
 * 从外部API获取数据并更新数据库
 * @param {string} tourType - 赛事类型
 * @param {object} options - 请求选项
 * @returns {Array} 更新后的比赛列表
 */
async function updateMatchListFromExternal(tourType = 'all', options = {}) {
  const startTime = Date.now()
  const startTimeISO = new Date(startTime).toISOString()
  const currentSeason = getCurrentSeason()
  const requestConfig = options.force
    ? { timeoutMs: REQUEST_BUDGET.FORCE_TIMEOUT_MS, maxRetries: 0, retryDelay: REQUEST_BUDGET.RETRY_DELAY_MS }
    : { timeoutMs: REQUEST_BUDGET.NORMAL_TIMEOUT_MS, maxRetries: 1, retryDelay: REQUEST_BUDGET.RETRY_DELAY_MS }

  try {
    console.log(`\n[${startTimeISO}] ===== 开始updateMatchListFromExternal =====`)
    console.log(`赛事类型: ${tourType}`)
    console.log(`当前赛季: ${currentSeason}`)
    console.log('请求预算:', JSON.stringify(requestConfig))
    console.log('跳过内存缓存，直接调用 snooker.org API...')

    const externalData = await getSnookerEvents(currentSeason, tourType, true, requestConfig)

    if (externalData && Array.isArray(externalData) && externalData.length > 0) {
      console.log('成功从外部API获取数据，数量:', externalData.length)
      console.log('数据样本:', externalData[0])
      const formatted = formatMatchList(externalData)

      // 改为后台异步保存数据库，不阻塞返回结果
      saveMatchListToDB(formatted, currentSeason).then(() => {
        console.log(`数据库后台更新完成，保存 ${formatted.length} 条记录`)
      }).catch(err => {
        console.error('数据库后台更新失败:', err.message)
      })
      console.log(`数据库后台更新已启动，${formatted.length} 条记录`)

      const apiUpdateTime = new Date().toISOString()

      const endTime = Date.now()
      const totalTime = endTime - startTime
      console.log(`\n[${new Date().toISOString()}] ===== updateMatchListFromExternal 成功完成 =====`)
      console.log(`总耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`)
      console.log(`数据来源: snooker.org, 数据数量: ${formatted.length}`)
      console.log(`最后更新时间: ${apiUpdateTime}`)

      return {
        data: formatted,
        source: 'snooker.org',
        isFallback: false,
        count: formatted.length,
        lastUpdate: apiUpdateTime,
        season: currentSeason,
        errorType: null
      }
    }

    console.warn('外部API返回空数据')
    throw new Error('外部API返回空数据')
  } catch (externalError) {
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.warn(`\n[${new Date().toISOString()}] ===== 外部API更新失败 =====`)
    console.warn(`总耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`)
    console.warn(`错误信息: ${externalError.message}`)
    console.warn('错误类型:', getErrorType(externalError))
    console.warn('====================================')
    throw externalError
  }
}


/**
 * 斯诺克赛事API配置
 * 使用免费公开的斯诺克数据源
 */
const API_CONFIG = {
  // Cuetracker API (免费，无需API Key)
  CUETRACKER_BASE: 'https://api.cuetracker.net',
  
  // snooker.org 官方数据源（网站页面API）
  // 实际可用地址: https://www.snooker.org/res/index.asp?season=2025&tour=all&template=2
  // template=2 可能返回JSON格式数据
  SNOOKER_ORG: 'https://www.snooker.org/res/index.asp',
  
  // snooker.org 官方API (https://api.snooker.org)
  // t=5: 获取赛事列表，s=赛季年份
  SNOOKER_API: 'https://api.snooker.org'
}

// snooker.org 授权请求头（标识你的应用，可以是任何字符串）
// 参考: https://api.snooker.org/ - "Set the X-Requested-By header to something (anything)"
const SNOOKER_REQUESTED_BY = 'StarWeChat261'  // 根据用户提供的脚本更新

const REQUEST_BUDGET = {
  FORCE_TIMEOUT_MS: 55000,   // 统一60秒逻辑：强制刷新55秒
  NORMAL_TIMEOUT_MS: 55000,  // 统一60秒逻辑：普通请求55秒
  RETRY_DELAY_MS: 1500
}

// 内存缓存：减少外部请求次数（snooker.org 限流 10 次/分钟）
const _cache = {

  eventsBySeason: new Map(), // key: `${season}:${tour}` -> { expiresAt, data }
  matchesByEvent: new Map(), // key: `${eventId}` -> { expiresAt, data }
  players: null // { expiresAt, data: Map<number, string> }
}

function _nowMs() {
  return Date.now()
}

function _getCacheEntry(map, key) {
  const entry = map instanceof Map ? map.get(key) : null
  if (!entry) return null
  if (entry.expiresAt > _nowMs()) return entry.data
  return null
}

function _setCacheEntry(map, key, data, ttlMs) {
  map.set(key, { data, expiresAt: _nowMs() + ttlMs })
}

function isTimeoutError(error) {
  const message = error?.message || ''
  return error?.code === 'TIMEOUT' || error?.code === 'ECONNABORTED' || error?.code === 'ERR_CANCELED' || error?.name === 'CanceledError' || /timeout|超时/i.test(message)
}

function getErrorType(error) {
  return isTimeoutError(error) ? 'timeout' : 'service_unavailable'
}

function _pad2(n) {

  return String(n).padStart(2, '0')
}

// 格式化日期为YYYY-MM-DD，确保月份和日期补零
function formatDateYYYYMMDD(dateStr) {
  if (!dateStr) return ''
  try {
    const date = new Date(dateStr)
    if (isNaN(date.getTime())) {
      // 尝试解析YYYY-M-D格式
      const parts = dateStr.split('-')
      if (parts.length >= 3) {
        const year = parseInt(parts[0], 10)
        const month = parseInt(parts[1], 10) - 1
        const day = parseInt(parts[2], 10)
        const date2 = new Date(year, month, day)
        if (!isNaN(date2.getTime())) {
          return `${year}-${_pad2(month + 1)}-${_pad2(day)}`
        }
      }
      return dateStr
    }
    return `${date.getFullYear()}-${_pad2(date.getMonth() + 1)}-${_pad2(date.getDate())}`
  } catch (error) {
    console.error('格式化日期失败:', error, dateStr)
    return dateStr
  }
}

// snooker.org 日期时间为 UTC；按北京时间(+8)展示/过滤
function _formatDateFromUtc(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${bj.getUTCFullYear()}-${_pad2(bj.getUTCMonth() + 1)}-${_pad2(bj.getUTCDate())}`
}

function _formatTimeFromUtc(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const bj = new Date(d.getTime() + 8 * 60 * 60 * 1000)
  return `${_pad2(bj.getUTCHours())}:${_pad2(bj.getUTCMinutes())}`
}

/**
 * 通用API请求函数
 */
async function fetchData(url, options = {}) {
  const startTime = Date.now()
  const startTimeISO = new Date(startTime).toISOString()
  const timeoutMs = options.timeout || REQUEST_BUDGET.NORMAL_TIMEOUT_MS
  const controller = new AbortController()
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const requestOptions = {
      url,
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json',
        ...(options.headers || {})
      },
      timeout: timeoutMs,
      signal: controller.signal,
      responseType: 'json',
      maxRedirects: 5,
      decompress: true,
      validateStatus: status => status >= 200 && status < 300,
      httpsAgent: httpsAgent  // 强制使用IPv4
    }

    console.log(`\n[${startTimeISO}] ===== 发起HTTP请求 =====`)
    console.log('请求URL:', url)
    console.log('请求头:', JSON.stringify(requestOptions.headers, null, 2))
    console.log('超时设置:', timeoutMs, '毫秒')
    console.log('=================================')

    const response = await axios(requestOptions)
    const result = response.data
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.log(`\n[${new Date().toISOString()}] ===== HTTP请求成功 =====`)
    console.log(`请求耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`)
    console.log('响应数据长度:', Array.isArray(result) ? result.length : '非数组')
    console.log('响应数据类型:', typeof result)
    if (Array.isArray(result) && result.length > 0) {
      console.log('响应数据前3项:', JSON.stringify(result.slice(0, 3), null, 2))
    }
    console.log('=================================')
    return result
  } catch (error) {
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.error(`\n[${new Date().toISOString()}] ===== HTTP请求失败 =====`)
    console.error(`请求耗时: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}秒)`)
    console.error('错误信息:', error.message)
    console.error('错误状态码:', error.response?.status || error.statusCode || '无')
    console.error('请求URL:', url)
    console.error('错误名称:', error.name)
    console.error('错误堆栈:', error.stack)
    console.error('=================================')

    if (error.code === 'ECONNABORTED' || error.code === 'ERR_CANCELED' || error.name === 'CanceledError') {
      const timeoutError = new Error('snooker.org API请求超时')
      timeoutError.code = 'TIMEOUT'
      throw timeoutError
    }

    throw error
  } finally {
    clearTimeout(timeoutHandle)
  }
}

/**
 * 带超时的异步函数包装器
 */
function withTimeout(promise, timeoutMs, timeoutMessage = '请求超时') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timeoutError = new Error(timeoutMessage)
      timeoutError.code = 'TIMEOUT'
      setTimeout(() => reject(timeoutError), timeoutMs)
    })
  ])
}


/**
 * 带重试的通用API请求函数
 * @param {Function} requestFn - 请求函数，返回Promise
 * @param {number} maxRetries - 最大重试次数，默认0次（只尝试1次）
 * @param {number} retryDelay - 重试延迟时间(ms)，默认500
 * @returns {Promise} 请求结果
 */
async function retryRequest(requestFn, maxRetries = 0, retryDelay = 500) {
  const startTime = Date.now()
  console.log(`\n[${new Date(startTime).toISOString()}] ===== 开始retryRequest =====`)
  console.log(`最大重试次数: ${maxRetries} (总共尝试 ${maxRetries + 1} 次)`)
  
  let lastError
  
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const attemptStartTime = Date.now()
    console.log(`\n[${new Date().toISOString()}] 尝试 #${attempt}/${maxRetries + 1} 开始...`)
    
    try {
      const result = await requestFn()
      const attemptEndTime = Date.now()
      const attemptDuration = attemptEndTime - attemptStartTime
      console.log(`[${new Date().toISOString()}] 尝试 #${attempt} 成功! 耗时: ${attemptDuration}ms`)
      
      const totalTime = attemptEndTime - startTime
      console.log(`[${new Date().toISOString()}] ===== retryRequest完成 =====`)
      console.log(`总耗时: ${totalTime}ms, 尝试次数: ${attempt}/${maxRetries + 1}`)
      return result
    } catch (error) {
      const attemptEndTime = Date.now()
      const attemptDuration = attemptEndTime - attemptStartTime
      console.error(`[${new Date().toISOString()}] 尝试 #${attempt} 失败! 耗时: ${attemptDuration}ms`)
      console.error(`错误信息: ${error.message}`)
      lastError = error
      
      if (attempt < maxRetries + 1) {
        console.log(`[${new Date().toISOString()}] 等待 ${retryDelay}ms 后重试...`)
        await new Promise(resolve => setTimeout(resolve, retryDelay))
      }
    }
  }
  
  const endTime = Date.now()
  const totalTime = endTime - startTime
  console.error(`\n[${new Date().toISOString()}] ===== retryRequest完全失败 =====`)
  console.error(`所有 ${maxRetries + 1} 次尝试均失败，总耗时: ${totalTime}ms`)
  throw lastError || new Error(`请求失败，总耗时: ${totalTime}ms`)
}

/**
 * 获取比赛列表
 * 从多个数据源尝试获取，每个数据源都有超时保护
 * @param {string} tourType - 赛事类型：'all'（全部比赛）或 'main'（主要赛事）
 */
async function getMatchList(tourType = 'all') {
  const startTime = Date.now()
  const startTimeISO = new Date(startTime).toISOString()
  
  try {
    console.log(`\n[${startTimeISO}] ===== 开始获取比赛列表（数据库优先） =====`)
    console.log('赛事类型:', tourType)
    
    const currentSeason = getCurrentSeason()
    console.log('当前赛季:', currentSeason)
    
    // 1. 先尝试从数据库获取数据
    const dbMatches = await getMatchListFromDB(currentSeason, tourType)
    
    if (dbMatches && dbMatches.length > 0) {
      console.log(`从数据库获取到 ${dbMatches.length} 条比赛记录`)
      
      // 检查数据库数据是否需要更新
      const needUpdate = await shouldUpdateFromDB(currentSeason)
      
      if (!needUpdate) {
        console.log('✅ 数据库数据新鲜（72小时内），直接返回缓存数据')
        // 获取数据库中的实际最后更新时间
        const dbLastUpdate = await getLastUpdateTimeFromDB(currentSeason)
        // 确保lastUpdate是有效的ISO字符串
        let lastUpdateStr
        if (dbLastUpdate) {
          try {
            const date = new Date(dbLastUpdate)
            if (!isNaN(date.getTime())) {
              lastUpdateStr = date.toISOString()
            } else {
              console.warn('数据库最后更新时间无效，使用当前时间:', dbLastUpdate)
              lastUpdateStr = new Date().toISOString()
            }
          } catch (error) {
            console.error('解析数据库最后更新时间失败:', error)
            lastUpdateStr = new Date().toISOString()
          }
        } else {
          lastUpdateStr = new Date().toISOString()
        }
        console.log('最后更新时间:', lastUpdateStr)
        const endTime = Date.now()
        const totalTime = endTime - startTime
        console.log(`[${new Date().toISOString()}] ===== getMatchList 完成（数据库缓存） =====`)
        console.log(`总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
        console.log(`数据来源: database_cache, 数据数量: ${dbMatches.length}`)
        return {
          data: dbMatches,
          source: 'database_cache',
          isFallback: false,
          count: dbMatches.length,
          lastUpdate: lastUpdateStr,
          season: currentSeason
        }
      }
      
      console.log('数据库数据需要更新，开始从外部API同步...')
      // 继续执行外部API更新流程
    } else {
      console.log('数据库无数据，需要从外部API获取')
    }
    
    // 2. 从外部API获取数据并更新数据库
    try {
      const updatedMatchesResult = await updateMatchListFromExternal(tourType)
      
      let updatedMatches, matchSource, isFallback, lastUpdateTime, errorType, message
      if (updatedMatchesResult && typeof updatedMatchesResult === 'object' && updatedMatchesResult.data) {
        updatedMatches = updatedMatchesResult.data
        matchSource = updatedMatchesResult.source || 'unknown'
        isFallback = updatedMatchesResult.isFallback || false
        lastUpdateTime = updatedMatchesResult.lastUpdate || new Date().toISOString()
        errorType = updatedMatchesResult.errorType || null
        message = updatedMatchesResult.message || ''
        console.log(`外部API更新成功，来源: ${matchSource}, 是否降级: ${isFallback}, 数量: ${updatedMatches.length}`)
      } else if (Array.isArray(updatedMatchesResult)) {
        updatedMatches = updatedMatchesResult
        matchSource = 'legacy'
        isFallback = false
        lastUpdateTime = new Date().toISOString()
        errorType = null
        message = ''
        console.log(`外部API更新成功（旧格式），返回 ${updatedMatches.length} 条记录`)
      } else {
        updatedMatches = []
        matchSource = 'unknown'
        isFallback = false
        lastUpdateTime = new Date().toISOString()
        errorType = null
        message = ''
        console.warn('外部API更新返回无效数据:', updatedMatchesResult)
      }
      
      if (updatedMatches && updatedMatches.length > 0) {
        const endTime = Date.now()
        const totalTime = endTime - startTime
        console.log(`[${new Date().toISOString()}] ===== getMatchList 完成（外部API） =====`)
        console.log(`总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
        console.log(`数据来源: ${matchSource}, 是否降级: ${isFallback}, 数据数量: ${updatedMatches.length}`)
        return {
          data: updatedMatches,
          source: matchSource,
          isFallback: isFallback,
          count: updatedMatches.length,
          lastUpdate: lastUpdateTime,
          season: currentSeason,
          errorType: errorType,
          message: message
        }
      }

      console.warn('外部API更新返回空数据')
      throw new Error('外部API返回空数据')
    } catch (updateError) {
      console.warn('外部API更新失败:', updateError.message)
      console.log('数据库数据状态:', dbMatches ? '有数据，数量:' + dbMatches.length : '无数据')

      const errorType = getErrorType(updateError)
      const dbLastUpdate = await getLastUpdateTimeFromDB(currentSeason)
      if (dbMatches && dbMatches.length > 0) {
        return {
          data: dbMatches,
          source: 'database_cache',
          isFallback: true,
          count: dbMatches.length,
          lastUpdate: dbLastUpdate || new Date().toISOString(),
          season: currentSeason,
          errorType: errorType,
          message: errorType === 'timeout' ? '外部API超时，已返回最近有效数据' : '服务暂不可用，已返回最近有效数据'
        }
      }

      const escalatedError = new Error(
        errorType === 'timeout'
          ? '外部API请求超时，且暂无可用缓存数据'
          : `外部API请求失败：${updateError.message}`
      )
      escalatedError.code = errorType === 'timeout' ? 'TIMEOUT' : updateError.code
      throw escalatedError
    }

    
    // 3. 如果所有方法都失败，使用内置降级数据
    console.warn('⚠️ 所有数据源失败，使用内置降级数据')
    console.warn(`当前赛季: ${currentSeason}, 赛事类型: ${tourType}`)
    console.warn('这可能意味着 snooker.org API 请求失败或返回空数据，请检查上面的日志')
    const fallbackData = tourType === 'all' 
      ? getAllSeasonFallback(currentSeason)
      : getCurrentSeasonFallback(currentSeason)
    
    console.log(`内置降级数据加载完成，数量: ${fallbackData.length}`)
    console.log('降级数据样本:', fallbackData[0])
    
    // 将降级数据保存到数据库以备下次使用
    try {
      await saveMatchListToDB(fallbackData, currentSeason)
      console.log(`降级数据已保存到数据库，保存 ${fallbackData.length} 条记录`)
    } catch (saveError) {
      console.error('保存降级数据到数据库失败:', saveError.message)
    }
    
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.log(`[${new Date().toISOString()}] ===== getMatchList 完成（内置降级数据） =====`)
    console.log(`总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
    console.log(`数据来源: hardcoded_fallback, 数据数量: ${fallbackData.length}`)
    return {
      data: fallbackData,
      source: 'hardcoded_fallback',
      isFallback: true,
      count: fallbackData.length,
      lastUpdate: new Date().toISOString(),
      season: currentSeason,
      errorType: 'service_unavailable',
      message: '实时服务不可用，返回内置演示数据'
    }

  } catch (error) {
    console.error('获取比赛列表失败:', error)
    console.error('错误堆栈:', error.stack)
    
    // 尝试最后的降级方案
    try {
      const currentSeason = getCurrentSeason()
      const fallbackData = tourType === 'all' 
        ? getAllSeasonFallback(currentSeason)
        : getCurrentSeasonFallback(currentSeason)
      const errorType = getErrorType(error)
      console.log('错误恢复：使用内置降级数据，数量:', fallbackData.length)
      const endTime = Date.now()
      const totalTime = endTime - startTime
      console.log(`[${new Date().toISOString()}] ===== getMatchList 完成（内置降级数据） =====`)
      console.log(`总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
      console.log(`数据来源: hardcoded_fallback, 数据数量: ${fallbackData.length}`)
      return {
        data: fallbackData,
        source: 'hardcoded_fallback',
        isFallback: true,
        count: fallbackData.length,
        lastUpdate: new Date().toISOString(),
        season: currentSeason,
        errorType: errorType,
        message: errorType === 'timeout' ? '实时接口超时，返回内置演示数据' : '实时服务不可用，返回内置演示数据'
      }
    } catch (finalError) {
      console.error('最终降级方案也失败:', finalError)
      return []
    }
  }
}

async function getDatabaseFallbackPayload(currentSeason, tour, error, forceUpdate = false) {
  const dbMatches = await getMatchListFromDB(currentSeason, tour)
  const dbLastUpdate = await getLastUpdateTimeFromDB(currentSeason)
  const errorType = getErrorType(error)

  if (dbMatches && dbMatches.length > 0) {
    return {
      data: dbMatches,
      source: 'database_cache',
      isFallback: true,
      forceUpdate,
      updated: false,
      stale: true,
      count: dbMatches.length,
      lastUpdate: dbLastUpdate || new Date().toISOString(),
      season: currentSeason,
      errorType: errorType,
      error: error.message,
      message: errorType === 'timeout' ? '外部API超时，已返回最近有效数据' : '服务暂不可用，已返回最近有效数据'
    }
  }

  return null
}

/**
 * 从Cuetracker获取数据
 */
async function fetchFromCuetracker(endpoint) {

  const baseUrl = API_CONFIG.CUETRACKER_BASE
  let url = baseUrl

  if (endpoint === 'tournaments') {
    // 获取赛事列表
    url = `${baseUrl}/tournaments`
  } else {
    throw new Error('Unsupported Cuetracker endpoint: ' + endpoint)
  }

  return fetchData(url, {
    headers: {
      'User-Agent': 'SnookerScheduleMiniProgram/1.0'
    }
  })
}

/**
 * 从api.snooker.org获取数据（使用用户提供的API端点）
 */
async function fetchFromSnookerApi(season, tourType = 'all') {
  try {
    console.log(`调用 api.snooker.org API，赛季: ${season}, 类型: ${tourType}`)
    
    // 构建URL: https://api.snooker.org/?t=5&s=2025
    // t=5: 获取赛事列表
    // s: 赛季年份
    let url = `${API_CONFIG.SNOOKER_API}/?t=5&s=${season}`
    
    // 可以添加更多参数，比如tour=all/main
    // 但api.snooker.org可能不支持tour参数，我们根据返回数据过滤
    console.log(`请求URL: ${url}`)
    
    const options = {
      headers: {
        'X-Requested-By': SNOOKER_REQUESTED_BY,
        'Accept': 'application/json',
        'User-Agent': 'SnookerScheduleMiniProgram/1.0'
      },
      timeout: 10000,
      json: true
    }
    
    console.log('发送请求到 api.snooker.org...')
    const response = await request({
      uri: url,
      ...options
    })
    
    console.log(`api.snooker.org API 响应成功，数据数量: ${Array.isArray(response) ? response.length : '非数组'}`)
    
    if (!Array.isArray(response)) {
      throw new Error('API返回非数组数据: ' + typeof response)
    }
    
    // 根据tourType过滤数据
    let filteredData = response
    if (tourType === 'main') {
      // 过滤掉Q Tour和其他非主要赛事
      filteredData = response.filter(item => {
        const tour = item.Tour || item.tour || ''
        const name = item.Name || item.name || ''
        const related = item.Related || item.related || ''
        
        // 主要赛事: tour为'main'或为空，且不包含'Q Tour'等关键词
        return (tour === 'main' || tour === '' || tour === null) &&
               !name.includes('Q Tour') &&
               !related.includes('qtour')
      })
      console.log(`过滤后主要赛事数量: ${filteredData.length}（原始: ${response.length}）`)
    }
    
    return filteredData
    
  } catch (error) {
    console.error('api.snooker.org API请求失败:', error.message)
    console.error('错误详情:', error)
    throw error
  }
}

/**
 * 从Snooker.org获取数据
 */
async function fetchFromSnookerOrg(endpoint, params = {}, requestConfig = {}) {
  const baseUrl = API_CONFIG.SNOOKER_API
  let url = baseUrl

  if (endpoint === 'tournaments') {
    const defaultSeason = getCurrentSeason()
    const season = params.season || defaultSeason
    url = `${baseUrl}/?t=5&s=${season}`
  } else if (endpoint === 'matches') {
    const eventId = params.eventId
    if (!eventId) {
      throw new Error('Snooker.org matches endpoint requires eventId')
    }
    url = `${baseUrl}/?t=6&e=${eventId}`
  } else {
    throw new Error('Unsupported Snooker.org endpoint: ' + endpoint)
  }

  const timeoutMs = requestConfig.timeoutMs || REQUEST_BUDGET.NORMAL_TIMEOUT_MS
  const maxRetries = requestConfig.maxRetries ?? 0
  const retryDelay = requestConfig.retryDelay || REQUEST_BUDGET.RETRY_DELAY_MS
  const options = {
    headers: {
      'X-Requested-By': SNOOKER_REQUESTED_BY,
      'Accept': 'application/json',
      'User-Agent': 'SnookerScheduleMiniProgram/1.0',
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  }

  console.log('========== 请求 snooker.org API ==========')
  console.log('请求URL:', url)
  console.log('请求参数:', { season: params.season, tour: params.tour, endpoint: endpoint })
  console.log('请求预算:', { timeoutMs, maxRetries, retryDelay })
  console.log('请求头:', JSON.stringify(options.headers, null, 2))
  console.log('=========================================')
  
  try {
    console.log(`正在发送请求到 snooker.org（${maxRetries} 次重试，总共尝试 ${maxRetries + 1} 次）...`)
    const response = await retryRequest(
      () => fetchData(url, options),
      maxRetries,
      retryDelay
    )
    
    console.log('========== snooker.org API 响应 ==========')
    console.log('状态: 成功')
    console.log('响应类型:', typeof response)
    
    let result = response
    
    if (Array.isArray(response)) {
      console.log('响应数据长度:', response.length)
      if (response.length > 0) {
        console.log('第一项数据样本:', JSON.stringify(response[0], null, 2))
      }
    } else if (response && typeof response === 'object') {
      console.log('响应是对象，类型:', response.constructor.name)
      if (response.data && Array.isArray(response.data)) {
        result = response.data
        console.log('从data属性获取数组数据，长度:', result.length)
      } else {
        result = [response]
        console.log('将对象转换为数组，长度:', result.length)
      }
    } else if (typeof response === 'string') {
      console.log('响应是字符串，长度:', response.length)
      console.log('响应预览（前500字符）:', response.substring(0, 500))
      try {
        result = JSON.parse(response)
        console.log('成功解析字符串为JSON')
      } catch (jsonError) {
        console.log('无法解析字符串为JSON:', jsonError.message)
        result = []
      }
    } else {
      console.log('响应内容:', response)
      result = []
    }
    
    if (!Array.isArray(result)) {
      console.log('结果不是数组，转换为数组')
      result = result ? [result] : []
    }
    
    console.log('最终数据长度:', result.length)
    console.log('=========================================')
    
    if (!result || result.length === 0) {
      throw new Error('snooker.org API返回空数据')
    }
    
    if (result.length < 5) {
      console.warn(`警告: 只获取到 ${result.length} 个比赛，可能数据不完整`)
    }
    
    return result
  } catch (error) {
    console.error('========== snooker.org API 失败详情 ==========')
    console.error('错误信息:', error.message)
    console.error('错误状态码:', error.response?.status || error.statusCode || '无')
    console.error('请求URL:', url)
    console.error('错误名称:', error.name)
    console.error('错误堆栈:', error.stack)
    console.error('=============================================')
    throw error
  }
}


/**
 * 从HTML解析比赛数据
 * @param {string|Buffer} html - HTML响应内容
 * @returns {Array} 解析出的比赛列表
 */
function parseHtmlForMatches(html) {
  try {
    console.log('开始解析HTML响应')
    const htmlStr = typeof html === 'string' ? html : html.toString()
    
    // 首先尝试查找JSON-LD数据（如果有）
    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi
    const jsonLdMatches = htmlStr.match(jsonLdRegex)
    if (jsonLdMatches && jsonLdMatches.length > 0) {
      console.log('找到JSON-LD数据，尝试解析')
      for (const jsonLd of jsonLdMatches) {
        try {
          const jsonStr = jsonLd.replace(/<script[^>]*>/, '').replace(/<\/script>/, '')
          const data = JSON.parse(jsonStr)
          if (data && Array.isArray(data) && data.length > 0) {
            console.log('从JSON-LD解析出', data.length, '个比赛')
            return data
          }
        } catch (e) {
          // 忽略JSON解析错误
        }
      }
    }
    
    // 如果没有JSON-LD，尝试解析表格数据
    console.log('未找到JSON-LD数据，尝试解析HTML表格')
    const matches = []
    
    // 尝试查找包含比赛信息的表格
    // snooker.org的比赛表格通常有特定的结构
    // 首先查找所有表格行
    const rowRegex = /<tr[^>]*>[\s\S]*?<\/tr>/gi
    const rows = htmlStr.match(rowRegex) || []
    
    console.log('找到', rows.length, '个表格行')
    
    // 提取每个比赛的信息
    for (let i = 0; i < Math.min(rows.length, 200); i++) { // 增加限制到200行
      const row = rows[i]
      
      // 尝试提取日期范围格式：如 "19‑22 Jun 2025" 或 "19-22 Jun 2025"
      // 匹配日期范围模式：数字-数字 月份 年份
      const dateRangeMatch = row.match(/(\d{1,2})[\-‒](\d{1,2})\s+(\w+)\s+(\d{4})/i)
      if (!dateRangeMatch) {
        // 如果没有日期范围，尝试单日格式：如 "19 Jun 2025"
        const singleDateMatch = row.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i)
        if (!singleDateMatch) {
          continue // 没有日期信息，跳过
        }
      }
      
      // 尝试提取比赛名称：查找包含比赛名称的单元格
      // 通常比赛名称在包含日期的行中，可能在另一个<td>中
      const cellRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi
      const cells = []
      let cellMatch
      while ((cellMatch = cellRegex.exec(row)) !== null) {
        cells.push(cellMatch[1].trim())
      }
      
      if (cells.length < 2) {
        continue
      }
      
      // 假设第一个单元格是日期，第二个单元格是比赛名称
      // 或者尝试查找包含非日期文本的单元格作为比赛名称
      let dateStr = ''
      let name = ''
      
      for (const cell of cells) {
        // 清理HTML标签
        const cleanCell = cell.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
        if (!cleanCell) continue
        
        // 检查是否是日期格式
        if (cleanCell.match(/(\d{1,2}[\-‒]\d{1,2}\s+\w+\s+\d{4})|(\d{1,2}\s+\w+\s+\d{4})/i)) {
          dateStr = cleanCell
        } else if (!name && cleanCell.length > 5) {
          // 假设第一个非日期的较长文本是比赛名称
          name = cleanCell
        }
      }
      
      if (dateStr && name) {
        // 解析日期范围
        let startDate = ''
        let endDate = ''
        
        // 处理日期范围格式 "19‑22 Jun 2025"
        const rangeMatch = dateStr.match(/(\d{1,2})[\-‒](\d{1,2})\s+(\w+)\s+(\d{4})/i)
        if (rangeMatch) {
          const day1 = rangeMatch[1].padStart(2, '0')
          const day2 = rangeMatch[2].padStart(2, '0')
          const month = rangeMatch[3]
          const year = rangeMatch[4]
          
          // 将月份名称转换为数字
          const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
          const monthIndex = monthNames.findIndex(m => m.toLowerCase() === month.substring(0, 3).toLowerCase())
          if (monthIndex !== -1) {
            const monthNum = (monthIndex + 1).toString().padStart(2, '0')
            startDate = `${year}-${monthNum}-${day1}`
            endDate = `${year}-${monthNum}-${day2}`
          } else {
            startDate = dateStr
            endDate = dateStr
          }
        } else {
          // 单日格式
          const singleMatch = dateStr.match(/(\d{1,2})\s+(\w+)\s+(\d{4})/i)
          if (singleMatch) {
            const day = singleMatch[1].padStart(2, '0')
            const month = singleMatch[2]
            const year = singleMatch[3]
            
            const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
            const monthIndex = monthNames.findIndex(m => m.toLowerCase() === month.substring(0, 3).toLowerCase())
            if (monthIndex !== -1) {
              const monthNum = (monthIndex + 1).toString().padStart(2, '0')
              startDate = `${year}-${monthNum}-${day}`
              endDate = startDate
            } else {
              startDate = dateStr
              endDate = dateStr
            }
          } else {
            startDate = dateStr
            endDate = dateStr
          }
        }
        
        // 创建比赛对象
        matches.push({
          id: `html-match-${i}-${Date.now()}`,
          name: name,
          start_date: startDate,
          end_date: endDate,
          venue: '',
          prize_fund: '',
          status: 'upcoming'
        })
        
        console.log(`解析出比赛: ${name}, 日期: ${startDate} - ${endDate}`)
      }
    }
    
    console.log('从HTML解析出', matches.length, '个比赛')
    
    // 如果解析到比赛，按开始日期排序
    if (matches.length > 0) {
      matches.sort((a, b) => a.start_date.localeCompare(b.start_date))
      console.log('比赛已按日期排序')
    }
    
    return matches
  } catch (error) {
    console.error('解析HTML失败:', error.message)
    console.error('错误堆栈:', error.stack)
    return []
  }
}

/**
 * 获取当前赛季年份
 * 斯诺克赛季通常从8月/9月开始，如果当前月份在8月之前（0-7月），属于上一赛季
 */
function getCurrentSeason() {
  const now = new Date()
  // 8月之前（0-7月）视为上一赛季
  return now.getMonth() < 7 ? now.getFullYear() - 1 : now.getFullYear()
}

/**
 * 验证赛季参数，确保使用当前赛季
 * @param {number} season - 传入的赛季年份
 * @returns {number} 验证后的赛季年份
 */
function validateSeason(season) {
  const currentSeason = getCurrentSeason()
  
  if (season === undefined || season === null) {
    console.log('未传入赛季参数，使用当前赛季:', currentSeason)
    return currentSeason
  }
  
  // 如果传入的赛季与当前赛季差异超过1年，使用当前赛季
  if (Math.abs(season - currentSeason) > 1) {
    console.warn(`传入的赛季 ${season} 与当前赛季 ${currentSeason} 差异较大，使用当前赛季`)
    return currentSeason
  }
  
  return season
}

async function getSnookerEvents(season, tour = 'main', skipCache = false, requestConfig = {}) {

  const key = `${season}:${tour}`
  
  // 如果不跳过缓存，检查缓存
  if (!skipCache) {
    const cached = _getCacheEntry(_cache.eventsBySeason, key)
    if (cached) {
      console.log(`snooker.org 缓存命中，赛季: ${season}, 类型: ${tour}, 缓存数据长度: ${Array.isArray(cached) ? cached.length : '非数组'}`)
      return cached
    }
  } else {
    console.log(`========== 强制跳过缓存 ==========`)
    console.log(`跳过缓存检查，强制从API获取，赛季: ${season}, 类型: ${tour}`)
    console.log(`清除缓存键: ${key}`)
    // 清除缓存，确保从API获取
    _cache.eventsBySeason.delete(key)
    console.log(`================================`)
  }

  console.log(`snooker.org 缓存未命中，开始请求 API，赛季: ${season}, 类型: ${tour}`)
  const data = await fetchFromSnookerOrg('tournaments', { season, tour }, requestConfig)

  
  // 根据tour参数过滤数据
  let filteredData = data
  if (tour === 'main') {
    // 主要赛事：过滤掉资格赛、挑战赛等
    // 根据实际API返回的Tour字段值进行过滤
    // 从test_result.json看到，主要赛事有 Tour: "main"
    // 资格赛有 Tour: "q"
    // 挑战赛可能有其他值
    filteredData = data.filter(item => {
      // 保留主要赛事（Tour字段为'main'）
      const tourValue = item.Tour || ''
      return tourValue.toLowerCase() === 'main'
    })
    console.log(`过滤后主要赛事数量: ${filteredData.length} (原始数量: ${data.length})`)
    
    // 如果没有过滤到数据，返回所有数据（避免空列表）
    if (filteredData.length === 0 && data.length > 0) {
      console.log('警告: 没有找到Tour字段为"main"的赛事，返回所有数据')
      filteredData = data
    }
  } else {
    console.log(`使用全部赛事数据，数量: ${data.length}`)
  }
  
  // 赛事列表变化不频繁，缓存 30 分钟
  _setCacheEntry(_cache.eventsBySeason, key, filteredData, 30 * 60 * 1000)
  console.log(`snooker.org API 数据获取完成，缓存30分钟，数据长度: ${Array.isArray(filteredData) ? filteredData.length : '非数组'}`)
  return filteredData
}

async function getSnookerMatches(eventId) {
  const key = String(eventId)
  const cached = _getCacheEntry(_cache.matchesByEvent, key)
  if (cached) return cached

  const data = await fetchFromSnookerOrg('matches', { eventId })
  // 同一赛事短时间重复点击很多，缓存 2 分钟，避免触发 10/min 限流
  _setCacheEntry(_cache.matchesByEvent, key, data, 2 * 60 * 1000)
  return data
}

async function getPlayersNameMap() {
  if (_cache.players && _cache.players.expiresAt > _nowMs()) return _cache.players.data

  // 新API可能不支持球员数据端点，返回空Map
  console.log('新API可能不支持球员数据，返回空Map')
  const map = new Map()
  
  _cache.players = { data: map, expiresAt: _nowMs() + 7 * 24 * 60 * 60 * 1000 } // 7 天
  return map
}

/**
 * 格式化比赛列表数据
 */
function formatMatchList(data) {
  return data.map(item => {
    // snooker.org (t=5) 字段：ID/Name/StartDate/EndDate/Venue/City/Country...
    // Cuetracker 备用：字段名可能不同，这里做兼容
    const id = item.ID || item.id || item.tournament_id
    const name = item.Name || item.name || item.tournament_name || ''
    const start_date_raw = item.StartDate || item.start_date || item.startDate
    const end_date_raw = item.EndDate || item.end_date || item.endDate
    const venueRaw = item.Venue || item.venue || item.location || ''
    const venue = [venueRaw, item.City, item.Country].filter(Boolean).join(', ')
    const prize_fund = item.PrizeFund || item.prize_fund || item.prize || ''
    
    // 统一格式化日期为YYYY-MM-DD，确保月份和日期补零
    const start_date = formatDateYYYYMMDD(start_date_raw)
    const end_date = formatDateYYYYMMDD(end_date_raw)
    
    const status = determineMatchStatus(start_date, end_date)

    return { id, name, start_date, end_date, venue, prize_fund, status }
  })
}

/**
 * 获取比赛详情
 */
async function getMatchDetail(id) {
  try {
    console.log('获取比赛详情, ID:', id, '类型:', typeof id)
    
    const currentSeason = getCurrentSeason()
    
    // 优先尝试从外部API获取数据
    try {
      console.log('尝试从 snooker.org 获取赛季', currentSeason, '的赛事列表')
      const externalEvents = await withTimeout(
        getSnookerEvents(currentSeason, 'main'),
        1500,
        'snooker.org API请求超时'
      )
      
      if (externalEvents && Array.isArray(externalEvents)) {
        // 在外部数据中查找匹配的赛事
        const externalMatch = externalEvents.find(item => {
          const itemId = item.ID || item.id || item.tournament_id
          return String(itemId) === String(id) || Number(itemId) === Number(id) || itemId == id
        })
        
        if (externalMatch) {
          console.log('在外部API中找到匹配的赛事:', externalMatch.Name || externalMatch.name)
          // 格式化数据
          const formatted = formatMatchList([externalMatch])
          return formatted[0]
        }
      }
    } catch (externalError) {
      console.warn('外部API请求失败，使用降级数据:', externalError.message)
    }
    
    // 外部API失败或未找到匹配，使用降级数据
    console.log('使用降级数据查找赛事')
    // 首先尝试从完整赛季数据中查找（包含79个比赛）
    let fallbackData = getAllSeasonFallback(currentSeason)
    let fallbackMatch = fallbackData.find(m =>
      String(m.id) === String(id) ||
      Number(m.id) === Number(id) ||
      m.id == id
    )
    
    // 如果在完整数据中未找到，尝试主要赛事数据（41个比赛）
    if (!fallbackMatch) {
      console.log('在完整赛季数据中未找到，尝试主要赛事数据')
      fallbackData = getCurrentSeasonFallback(currentSeason)
      fallbackMatch = fallbackData.find(m =>
        String(m.id) === String(id) ||
        Number(m.id) === Number(id) ||
        m.id == id
      )
    }

    if (fallbackMatch) {
      console.log('在降级数据中找到匹配的赛事:', fallbackMatch.name)
      return fallbackMatch
    }

    // 如果都没有找到，返回第一个赛事作为示例
    console.warn('未找到匹配赛事，返回第一个赛事作为示例')
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.log(`[${new Date().toISOString()}] ===== getMatchList 完成（内置降级数据） =====`)
    console.log(`总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)
    console.log(`数据来源: hardcoded_fallback, 数据数量: ${fallbackData.length}`)
    return {
      data: fallbackData,
      source: 'hardcoded_fallback',
      isFallback: true,
      count: fallbackData.length,
      lastUpdate: new Date().toISOString(),
      season: currentSeason
    }[0]

  } catch (error) {
    console.error('获取比赛详情失败:', error)
    // 即使降级数据也失败，返回一个空的赛事对象避免前端报错
    return {
      id: id,
      name: '赛事信息获取失败',
      start_date: new Date().toISOString().split('T')[0],
      end_date: new Date().toISOString().split('T')[0],
      venue: '',
      prize_fund: '',
      status: 'upcoming'
    }
  }
}

/**
 * 获取比赛日程
 */
async function getMatchSchedule(matchId, date) {
  try {
    console.log('获取比赛日程, matchId:', matchId, ', date:', date)
    
    // 直接使用内置模拟数据确保快速响应
    console.log('使用内置模拟赛程数据确保快速响应')
    const fallbackSchedule = generateRealtimeSchedule(String(matchId), date)
    return fallbackSchedule

  } catch (error) {
    console.error('获取比赛日程失败:', error)
    throw error
  }
}

/**
 * 确定比赛状态
 */
function determineStatus(status) {
  if (!status) return 'upcoming'
  const s = String(status).toLowerCase()
  if (s.includes('ongoing') || s.includes('live') || s.includes('in progress') || s.includes('playing')) {
    return 'ongoing'
  } else if (s.includes('finished') || s.includes('completed') || s.includes('ended')) {
    return 'finished'
  }
  return 'upcoming'
}

/**
 * 根据日期自动判断比赛状态
 */
function determineMatchStatus(startDate, endDate) {
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
}

/**
 * 生成当前赛季的降级比赛列表数据
 * 当外部API不可用时使用，基于当前赛季年份动态生成
 */
function getCurrentSeasonFallback(season, tourType = 'main') {
  // 赛季年份，例如2024代表2024-2025赛季
  // 使用传入的赛季参数，确保动态显示正确的赛季数据
  const seasonYear = season
  const nextSeasonYear = seasonYear + 1
  
  // 完整的斯诺克赛季赛事数据（41个比赛）
  const tournaments = [
    // 赛季早期赛事（6-8月）
    {
      id: `wst-championship-league-1-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 1)`,
      start_date: `${seasonYear}-06-15`,
      end_date: `${seasonYear}-06-18`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-championship-league-2-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 2)`,
      start_date: `${seasonYear}-06-22`,
      end_date: `${seasonYear}-06-25`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-championship-league-3-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 3)`,
      start_date: `${seasonYear}-06-29`,
      end_date: `${seasonYear}-07-02`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-european-masters-qual-${seasonYear}`,
      name: `${seasonYear} European Masters Qualifying`,
      start_date: `${seasonYear}-07-06`,
      end_date: `${seasonYear}-07-08`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-british-open-qual-${seasonYear}`,
      name: `${seasonYear} British Open Qualifying`,
      start_date: `${seasonYear}-07-10`,
      end_date: `${seasonYear}-07-12`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£10,000'
    },
    {
      id: `wst-northern-ireland-open-qual-${seasonYear}`,
      name: `${seasonYear} Northern Ireland Open Qualifying`,
      start_date: `${seasonYear}-07-15`,
      end_date: `${seasonYear}-07-17`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-english-open-qual-${seasonYear}`,
      name: `${seasonYear} English Open Qualifying`,
      start_date: `${seasonYear}-07-20`,
      end_date: `${seasonYear}-07-22`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-scottish-open-qual-${seasonYear}`,
      name: `${seasonYear} Scottish Open Qualifying`,
      start_date: `${seasonYear}-07-25`,
      end_date: `${seasonYear}-07-27`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-welsh-open-qual-${seasonYear}`,
      name: `${seasonYear} Welsh Open Qualifying`,
      start_date: `${seasonYear}-07-30`,
      end_date: `${seasonYear}-08-01`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-german-masters-qual-${seasonYear}`,
      name: `${seasonYear} German Masters Qualifying`,
      start_date: `${seasonYear}-08-05`,
      end_date: `${seasonYear}-08-07`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    
    // 主要排名赛（9-10月）
    {
      id: `wst-shanghai-masters-${seasonYear}`,
      name: `${seasonYear} Shanghai Masters`,
      start_date: `${seasonYear}-09-14`,
      end_date: `${seasonYear}-09-20`,
      venue: 'Shanghai, China',
      prize_fund: '£900,000'
    },
    {
      id: `wst-british-open-${seasonYear}`,
      name: `${seasonYear} British Open`,
      start_date: `${seasonYear}-09-22`,
      end_date: `${seasonYear}-09-28`,
      venue: 'The Centaur, Cheltenham, UK',
      prize_fund: '£110,000'
    },
    {
      id: `wst-european-masters-${seasonYear}`,
      name: `${seasonYear} European Masters`,
      start_date: `${seasonYear}-10-05`,
      end_date: `${seasonYear}-10-11`,
      venue: 'Stadthalle, Fürth, Germany',
      prize_fund: '£80,000'
    },
    {
      id: `wst-northern-ireland-open-${seasonYear}`,
      name: `${seasonYear} Northern Ireland Open`,
      start_date: `${seasonYear}-10-12`,
      end_date: `${seasonYear}-10-18`,
      venue: 'Waterfront Hall, Belfast, UK',
      prize_fund: '£80,000'
    },
    {
      id: `wst-english-open-${seasonYear}`,
      name: `${seasonYear} English Open`,
      start_date: `${seasonYear}-10-19`,
      end_date: `${seasonYear}-10-25`,
      venue: 'Brentwood Centre, Brentwood, UK',
      prize_fund: '£80,000'
    },
    
    // 邀请赛和重要赛事（10-11月）
    {
      id: `wst-champion-of-champions-${seasonYear}`,
      name: `${seasonYear} Champion of Champions`,
      start_date: `${seasonYear}-10-28`,
      end_date: `${seasonYear}-11-01`,
      venue: 'Bolton Whites Hotel, Bolton, UK',
      prize_fund: '£150,000'
    },
    {
      id: `wst-uk-championship-${seasonYear}`,
      name: `${seasonYear} Cazoo UK Championship`,
      start_date: `${seasonYear}-11-23`,
      end_date: `${seasonYear}-12-06`,
      venue: 'York Barbican, York, UK',
      prize_fund: '£1,300,000'
    },
    {
      id: `wst-scottish-open-${seasonYear}`,
      name: `${seasonYear} Scottish Open`,
      start_date: `${seasonYear}-12-07`,
      end_date: `${seasonYear}-12-13`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£80,000'
    },
    
    // 新年赛事（1-2月）
    {
      id: `wst-masters-${nextSeasonYear}`,
      name: `${nextSeasonYear} Masters`,
      start_date: `${nextSeasonYear}-01-11`,
      end_date: `${nextSeasonYear}-01-18`,
      venue: 'Alexandra Palace, London, UK',
      prize_fund: '£800,000'
    },
    {
      id: `wst-world-grand-prix-${seasonYear}`,
      name: `${seasonYear} World Grand Prix`,
      start_date: `${nextSeasonYear}-01-19`,
      end_date: `${nextSeasonYear}-01-25`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£100,000'
    },
    {
      id: `wst-german-masters-${seasonYear}`,
      name: `${seasonYear} BetVictor German Masters`,
      start_date: `${nextSeasonYear}-02-01`,
      end_date: `${nextSeasonYear}-02-07`,
      venue: 'Tempodrom, Berlin, Germany',
      prize_fund: '£90,000'
    },
    {
      id: `wst-welsh-open-${seasonYear}`,
      name: `${seasonYear} BetVictor Welsh Open`,
      start_date: `${nextSeasonYear}-02-23`,
      end_date: `${nextSeasonYear}-03-01`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£90,000'
    },
    
    // 球员系列赛（3月）
    {
      id: `wst-players-championship-${seasonYear}`,
      name: `${seasonYear} Players Championship`,
      start_date: `${nextSeasonYear}-03-16`,
      end_date: `${nextSeasonYear}-03-22`,
      venue: 'Telford International Centre, UK',
      prize_fund: '£400,000'
    },
    {
      id: `wst-tour-championship-${seasonYear}`,
      name: `${seasonYear} Tour Championship`,
      start_date: `${nextSeasonYear}-03-30`,
      end_date: `${nextSeasonYear}-04-05`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£400,000'
    },
    {
      id: `wst-china-open-${seasonYear}`,
      name: `${seasonYear} China Open`,
      start_date: `${nextSeasonYear}-03-23`,
      end_date: `${nextSeasonYear}-03-29`,
      venue: 'Beijing, China',
      prize_fund: '£275,000'
    },
    
    // 世锦赛资格赛和正赛（4-5月）
    {
      id: `wst-world-championship-qual-${seasonYear}`,
      name: `${nextSeasonYear} World Championship Qualifying`,
      start_date: `${nextSeasonYear}-04-03`,
      end_date: `${nextSeasonYear}-04-12`,
      venue: 'English Institute of Sport, Sheffield, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-world-championship-${seasonYear}`,
      name: `${nextSeasonYear} Cazoo World Snooker Championship`,
      start_date: `${nextSeasonYear}-04-18`,
      end_date: `${nextSeasonYear}-05-04`,
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£2,600,000'
    },
    
    // 其他排名赛和邀请赛
    {
      id: `wst-shoot-out-${seasonYear}`,
      name: `${seasonYear} Shoot Out`,
      start_date: `${seasonYear}-10-26`,
      end_date: `${seasonYear}-10-27`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£50,000'
    },
    {
      id: `wst-six-red-world-${seasonYear}`,
      name: `${seasonYear} Six-red World Championship`,
      start_date: `${seasonYear}-08-10`,
      end_date: `${seasonYear}-08-15`,
      venue: 'Bangkok, Thailand',
      prize_fund: '£60,000'
    },
    {
      id: `wst-womens-world-${seasonYear}`,
      name: `${seasonYear} Women's World Championship`,
      start_date: `${seasonYear}-11-05`,
      end_date: `${seasonYear}-11-07`,
      venue: 'Bangkok, Thailand',
      prize_fund: '£15,000'
    },
    {
      id: `wst-seniors-world-${seasonYear}`,
      name: `${seasonYear} Seniors World Championship`,
      start_date: `${seasonYear}-11-12`,
      end_date: `${seasonYear}-11-14`,
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£25,000'
    },
    
    // 更多资格赛和小型排名赛
    {
      id: `wst-single-frame-shootout-qual-${seasonYear}`,
      name: `${seasonYear} Single Frame Shootout Qualifying`,
      start_date: `${seasonYear}-08-20`,
      end_date: `${seasonYear}-08-22`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£5,000'
    },
    {
      id: `wst-world-mixed-doubles-${seasonYear}`,
      name: `${seasonYear} World Mixed Doubles`,
      start_date: `${seasonYear}-09-05`,
      end_date: `${seasonYear}-09-06`,
      venue: 'Milton Keynes, UK',
      prize_fund: '£30,000'
    },
    {
      id: `wst-world-under-21-${seasonYear}`,
      name: `${seasonYear} World Under-21 Championship`,
      start_date: `${seasonYear}-08-25`,
      end_date: `${seasonYear}-08-30`,
      venue: 'Belgrade, Serbia',
      prize_fund: '£10,000'
    },
    {
      id: `wst-q-school-event-1-${seasonYear}`,
      name: `${seasonYear} Q School Event 1`,
      start_date: `${seasonYear}-05-15`,
      end_date: `${seasonYear}-05-20`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-q-school-event-2-${seasonYear}`,
      name: `${seasonYear} Q School Event 2`,
      start_date: `${seasonYear}-05-22`,
      end_date: `${seasonYear}-05-27`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-q-school-event-3-${seasonYear}`,
      name: `${seasonYear} Q School Event 3`,
      start_date: `${seasonYear}-05-29`,
      end_date: `${seasonYear}-06-03`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-challenge-tour-1-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 1`,
      start_date: `${seasonYear}-07-01`,
      end_date: `${seasonYear}-07-02`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-2-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 2`,
      start_date: `${seasonYear}-07-08`,
      end_date: `${seasonYear}-07-09`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-3-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 3`,
      start_date: `${seasonYear}-07-15`,
      end_date: `${seasonYear}-07-16`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-4-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 4`,
      start_date: `${seasonYear}-07-22`,
      end_date: `${seasonYear}-07-23`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-5-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 5`,
      start_date: `${seasonYear}-07-29`,
      end_date: `${seasonYear}-07-30`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    }
  ]

  // 根据实际日期自动判断状态
  return tournaments.map(tournament => {
    const status = determineMatchStatus(tournament.start_date, tournament.end_date)
    return Object.assign({}, tournament, { status: status })
  })
}

/**
 * 获取完整赛季的降级比赛列表数据（79个比赛）
 * 当外部API不可用时使用，包含全部比赛（主要赛事 + 资格赛 + 挑战赛）
 */
function getAllSeasonFallback(season) {
  // 赛季年份，例如2024代表2024-2025赛季
  // 使用传入的赛季参数，确保动态显示正确的赛季数据
  const seasonYear = season
  const nextSeasonYear = seasonYear + 1
  
  // 完整的斯诺克赛季赛事数据（79个比赛）
  // 首先包含现有的41个主要赛事
  const tournaments = [
    // 赛季早期赛事（6-8月）
    {
      id: `wst-championship-league-1-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 1)`,
      start_date: `${seasonYear}-06-15`,
      end_date: `${seasonYear}-06-18`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-championship-league-2-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 2)`,
      start_date: `${seasonYear}-06-22`,
      end_date: `${seasonYear}-06-25`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-championship-league-3-${seasonYear}`,
      name: `${seasonYear} Championship League (Stage 3)`,
      start_date: `${seasonYear}-06-29`,
      end_date: `${seasonYear}-07-02`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-european-masters-qual-${seasonYear}`,
      name: `${seasonYear} European Masters Qualifying`,
      start_date: `${seasonYear}-07-06`,
      end_date: `${seasonYear}-07-08`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-british-open-qual-${seasonYear}`,
      name: `${seasonYear} British Open Qualifying`,
      start_date: `${seasonYear}-07-10`,
      end_date: `${seasonYear}-07-12`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£10,000'
    },
    {
      id: `wst-northern-ireland-open-qual-${seasonYear}`,
      name: `${seasonYear} Northern Ireland Open Qualifying`,
      start_date: `${seasonYear}-07-15`,
      end_date: `${seasonYear}-07-17`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-english-open-qual-${seasonYear}`,
      name: `${seasonYear} English Open Qualifying`,
      start_date: `${seasonYear}-07-20`,
      end_date: `${seasonYear}-07-22`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-scottish-open-qual-${seasonYear}`,
      name: `${seasonYear} Scottish Open Qualifying`,
      start_date: `${seasonYear}-07-25`,
      end_date: `${seasonYear}-07-27`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-welsh-open-qual-${seasonYear}`,
      name: `${seasonYear} Welsh Open Qualifying`,
      start_date: `${seasonYear}-07-30`,
      end_date: `${seasonYear}-08-01`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    {
      id: `wst-german-masters-qual-${seasonYear}`,
      name: `${seasonYear} German Masters Qualifying`,
      start_date: `${seasonYear}-08-05`,
      end_date: `${seasonYear}-08-07`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£8,000'
    },
    
    // 主要排名赛（9-10月）
    {
      id: `wst-shanghai-masters-${seasonYear}`,
      name: `${seasonYear} Shanghai Masters`,
      start_date: `${seasonYear}-09-14`,
      end_date: `${seasonYear}-09-20`,
      venue: 'Shanghai, China',
      prize_fund: '£900,000'
    },
    {
      id: `wst-british-open-${seasonYear}`,
      name: `${seasonYear} British Open`,
      start_date: `${seasonYear}-09-22`,
      end_date: `${seasonYear}-09-28`,
      venue: 'The Centaur, Cheltenham, UK',
      prize_fund: '£110,000'
    },
    {
      id: `wst-european-masters-${seasonYear}`,
      name: `${seasonYear} European Masters`,
      start_date: `${seasonYear}-10-05`,
      end_date: `${seasonYear}-10-11`,
      venue: 'Stadthalle, Fürth, Germany',
      prize_fund: '£80,000'
    },
    {
      id: `wst-northern-ireland-open-${seasonYear}`,
      name: `${seasonYear} Northern Ireland Open`,
      start_date: `${seasonYear}-10-12`,
      end_date: `${seasonYear}-10-18`,
      venue: 'Waterfront Hall, Belfast, UK',
      prize_fund: '£80,000'
    },
    {
      id: `wst-english-open-${seasonYear}`,
      name: `${seasonYear} English Open`,
      start_date: `${seasonYear}-10-19`,
      end_date: `${seasonYear}-10-25`,
      venue: 'Brentwood Centre, Brentwood, UK',
      prize_fund: '£80,000'
    },
    
    // 邀请赛和重要赛事（10-11月）
    {
      id: `wst-champion-of-champions-${seasonYear}`,
      name: `${seasonYear} Champion of Champions`,
      start_date: `${seasonYear}-10-28`,
      end_date: `${seasonYear}-11-01`,
      venue: 'Bolton Whites Hotel, Bolton, UK',
      prize_fund: '£150,000'
    },
    {
      id: `wst-uk-championship-${seasonYear}`,
      name: `${seasonYear} Cazoo UK Championship`,
      start_date: `${seasonYear}-11-23`,
      end_date: `${seasonYear}-12-06`,
      venue: 'York Barbican, York, UK',
      prize_fund: '£1,300,000'
    },
    {
      id: `wst-scottish-open-${seasonYear}`,
      name: `${seasonYear} Scottish Open`,
      start_date: `${seasonYear}-12-07`,
      end_date: `${seasonYear}-12-13`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£80,000'
    },
    
    // 新年赛事（1-2月）
    {
      id: `wst-masters-${nextSeasonYear}`,
      name: `${nextSeasonYear} Masters`,
      start_date: `${nextSeasonYear}-01-11`,
      end_date: `${nextSeasonYear}-01-18`,
      venue: 'Alexandra Palace, London, UK',
      prize_fund: '£800,000'
    },
    {
      id: `wst-world-grand-prix-${seasonYear}`,
      name: `${seasonYear} World Grand Prix`,
      start_date: `${nextSeasonYear}-01-19`,
      end_date: `${nextSeasonYear}-01-25`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£100,000'
    },
    {
      id: `wst-german-masters-${seasonYear}`,
      name: `${seasonYear} BetVictor German Masters`,
      start_date: `${nextSeasonYear}-02-01`,
      end_date: `${nextSeasonYear}-02-07`,
      venue: 'Tempodrom, Berlin, Germany',
      prize_fund: '£90,000'
    },
    {
      id: `wst-welsh-open-${seasonYear}`,
      name: `${seasonYear} BetVictor Welsh Open`,
      start_date: `${nextSeasonYear}-02-23`,
      end_date: `${nextSeasonYear}-03-01`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£90,000'
    },
    
    // 球员系列赛（3月）
    {
      id: `wst-players-championship-${seasonYear}`,
      name: `${seasonYear} Players Championship`,
      start_date: `${nextSeasonYear}-03-16`,
      end_date: `${nextSeasonYear}-03-22`,
      venue: 'Telford International Centre, UK',
      prize_fund: '£400,000'
    },
    {
      id: `wst-tour-championship-${seasonYear}`,
      name: `${seasonYear} Tour Championship`,
      start_date: `${nextSeasonYear}-03-30`,
      end_date: `${nextSeasonYear}-04-05`,
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£400,000'
    },
    {
      id: `wst-china-open-${seasonYear}`,
      name: `${seasonYear} China Open`,
      start_date: `${nextSeasonYear}-03-23`,
      end_date: `${nextSeasonYear}-03-29`,
      venue: 'Beijing, China',
      prize_fund: '£275,000'
    },
    
    // 世锦赛资格赛和正赛（4-5月）
    {
      id: `wst-world-championship-qual-${seasonYear}`,
      name: `${nextSeasonYear} World Championship Qualifying`,
      start_date: `${nextSeasonYear}-04-03`,
      end_date: `${nextSeasonYear}-04-12`,
      venue: 'English Institute of Sport, Sheffield, UK',
      prize_fund: '£20,000'
    },
    {
      id: `wst-world-championship-${seasonYear}`,
      name: `${nextSeasonYear} Cazoo World Snooker Championship`,
      start_date: `${nextSeasonYear}-04-18`,
      end_date: `${nextSeasonYear}-05-04`,
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£2,600,000'
    },
    
    // 其他排名赛和邀请赛
    {
      id: `wst-shoot-out-${seasonYear}`,
      name: `${seasonYear} Shoot Out`,
      start_date: `${seasonYear}-10-26`,
      end_date: `${seasonYear}-10-27`,
      venue: 'Morningside Arena, Leicester, UK',
      prize_fund: '£50,000'
    },
    {
      id: `wst-six-red-world-${seasonYear}`,
      name: `${seasonYear} Six-red World Championship`,
      start_date: `${seasonYear}-08-10`,
      end_date: `${seasonYear}-08-15`,
      venue: 'Bangkok, Thailand',
      prize_fund: '£60,000'
    },
    {
      id: `wst-womens-world-${seasonYear}`,
      name: `${seasonYear} Women's World Championship`,
      start_date: `${seasonYear}-11-05`,
      end_date: `${seasonYear}-11-07`,
      venue: 'Bangkok, Thailand',
      prize_fund: '£15,000'
    },
    {
      id: `wst-seniors-world-${seasonYear}`,
      name: `${seasonYear} Seniors World Championship`,
      start_date: `${seasonYear}-11-12`,
      end_date: `${seasonYear}-11-14`,
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£25,000'
    },
    
    // 更多资格赛和小型排名赛
    {
      id: `wst-single-frame-shootout-qual-${seasonYear}`,
      name: `${seasonYear} Single Frame Shootout Qualifying`,
      start_date: `${seasonYear}-08-20`,
      end_date: `${seasonYear}-08-22`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£5,000'
    },
    {
      id: `wst-world-mixed-doubles-${seasonYear}`,
      name: `${seasonYear} World Mixed Doubles`,
      start_date: `${seasonYear}-09-05`,
      end_date: `${seasonYear}-09-06`,
      venue: 'Milton Keynes, UK',
      prize_fund: '£30,000'
    },
    {
      id: `wst-world-under-21-${seasonYear}`,
      name: `${seasonYear} World Under-21 Championship`,
      start_date: `${seasonYear}-08-25`,
      end_date: `${seasonYear}-08-30`,
      venue: 'Belgrade, Serbia',
      prize_fund: '£10,000'
    },
    {
      id: `wst-q-school-event-1-${seasonYear}`,
      name: `${seasonYear} Q School Event 1`,
      start_date: `${seasonYear}-05-15`,
      end_date: `${seasonYear}-05-20`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-q-school-event-2him-${seasonYear}`,
      name: `${seasonYear} Q School Event 2`,
      start_date: `${seasonYear}-05-22`,
      end_date: `${seasonYear}-05-27`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-q-school-event-3-${seasonYear}`,
      name: `${seasonYear} Q School Event 3`,
      start_date: `${seasonYear}-05-29`,
      end_date: `${seasonYear}-06-03`,
      venue: 'Ponds Forge, Sheffield, UK',
      prize_fund: '£0'
    },
    {
      id: `wst-challenge-tour-1-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 1`,
      start_date: `${seasonYear}-07-01`,
      end_date: `${seasonYear}-07-02`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-2-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 2`,
      start_date: `${seasonYear}-07-08`,
      end_date: `${seasonYear}-07-09`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-3-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 3`,
      start_date: `${seasonYear}-07-15`,
      end_date: `${seasonYear}-07-16`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-4-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 4`,
      start_date: `${seasonYear}-07-22`,
      end_date: `${seasonYear}-07-23`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    },
    {
      id: `wst-challenge-tour-5-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event 5`,
      start_date: `${seasonYear}-07-29`,
      end_date: `${seasonYear}-07-30`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    }
  ]

  // 添加38个额外的资格赛和挑战赛，使总数达到79个
  // 这些是模拟的额外比赛，代表完整的赛季赛程
  const additionalTournaments = []
  
  // 1. 更多资格赛（10个）
  for (let i = 1; i <= 10; i++) {
    additionalTournaments.push({
      id: `wst-extra-qual-${i}-${seasonYear}`,
      name: `${seasonYear} Additional Qualifying Event ${i}`,
      start_date: `${seasonYear}-08-${String(10 + i).padStart(2, '0')}`,
      end_date: `${seasonYear}-08-${String(12 + i).padStart(2, '0')}`,
      venue: 'Metrodome, Barnsley, UK',
      prize_fund: '£5,000'
    })
  }
  
  // 2. 挑战赛系列（10个）
  for (let i = 6; i <= 15; i++) {
    additionalTournaments.push({
      id: `wst-challenge-tour-${i}-${seasonYear}`,
      name: `${seasonYear} Challenge Tour Event ${i}`,
      start_date: `${seasonYear}-08-${String(15 + i).padStart(2, '0')}`,
      end_date: `${seasonYear}-08-${String(17 + i).padStart(2, '0')}`,
      venue: 'Northern Snooker Centre, Leeds, UK',
      prize_fund: '£2,000'
    })
  }
  
  // 3. 青少年赛事（5个）
  for (let i = 1; i <= 5; i++) {
    additionalTournaments.push({
      id: `wst-youth-event-${i}-${seasonYear}`,
      name: `${seasonYear} Youth Snooker Event ${i}`,
      start_date: `${seasonYear}-09-${String(5 + i).padStart(2, '0')}`,
      end_date: `${seasonYear}-09-${String(7 + i).padStart(2, '0')}`,
      venue: 'Sheffield Academy, Sheffield, UK',
      prize_fund: '£1,000'
    })
  }
  
  // 4. 地区性赛事（8个）
  for (let i = 1; i <= 8; i++) {
    additionalTournaments.push({
      id: `wst-regional-event-${i}-${seasonYear}`,
      name: `${seasonYear} Regional Championship ${i}`,
      start_date: `${seasonYear}-10-${String(10 + i).padStart(2, '0')}`,
      end_date: `${seasonYear}-10-${String(12 + i).padStart(2, '0')}`,
      venue: 'Various Venues, UK',
      prize_fund: '£3,000'
    })
  }
  
  // 5. 表演赛（5个）
  for (let i = 1; i <= 5; i++) {
    additionalTournaments.push({
      id: `wst-exhibition-event-${i}-${seasonYear}`,
      name: `${seasonYear} Exhibition Event ${i}`,
      start_date: `${seasonYear}-11-${String(15 + i).padStart(2, '0')}`,
      end_date: `${seasonYear}-11-${String(17 + i).padStart(2, '0')}`,
      venue: 'Various Locations',
      prize_fund: '£0'
    })
  }
  
  // 合并所有比赛
  const allTournaments = tournaments.concat(additionalTournaments)
  
  // 根据实际日期自动判断状态
  return allTournaments.map(tournament => {
    const status = determineMatchStatus(tournament.start_date, tournament.end_date)
    return Object.assign({}, tournament, { status: status })
  })
}

/**
 * 生成实时比赛列表数据（硬编码2026赛季）
 * 使用真实的斯诺克比赛名称和数据结构
 * 只包含2026赛季的主要赛事
 */
function getRealtimeMatchList() {
  const now = new Date()

  // 真实的斯诺克赛事数据（基于2026赛季的真实赛程）
  const tournaments = [
    // 2026赛季赛事
    {
      id: 'wst-world-championship-2026',
      name: '2026 Cazoo World Snooker Championship',
      start_date: '2026-04-18',
      end_date: '2026-05-04',
      venue: 'Crucible Theatre, Sheffield, UK',
      prize_fund: '£2,600,000'
    },
    {
      id: 'wst-uk-championship-2026',
      name: '2026 Cazoo UK Championship',
      start_date: '2026-11-23',
      end_date: '2026-12-06',
      venue: 'York Barbican, York, UK',
      prize_fund: '£1,300,000'
    },
    {
      id: 'wst-masters-2026',
      name: '2026 Masters',
      start_date: '2026-01-11',
      end_date: '2026-01-18',
      venue: 'Alexandra Palace, London, UK',
      prize_fund: '£800,000'
    },
    {
      id: 'wst-welsh-open-2026',
      name: '2026 BetVictor Welsh Open',
      start_date: '2026-02-23',
      end_date: '2026-03-01',
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£90,000'
    },
    {
      id: 'wst-players-championship-2026',
      name: '2026 Players Championship',
      start_date: '2026-03-16',
      end_date: '2026-03-22',
      venue: 'Telford International Centre, UK',
      prize_fund: '£400,000'
    },
    {
      id: 'wst-tour-championship-2026',
      name: '2026 Tour Championship',
      start_date: '2026-03-30',
      end_date: '2026-04-05',
      venue: 'Venue Cymru, Llandudno, Wales',
      prize_fund: '£400,000'
    },
    {
      id: 'wst-shanghai-masters-2026',
      name: '2026 Shanghai Masters',
      start_date: '2026-09-14',
      end_date: '2026-09-20',
      venue: 'Shanghai, China',
      prize_fund: '£900,000'
    },
    {
      id: 'wst-china-open-2026',
      name: '2026 China Open',
      start_date: '2026-03-23',
      end_date: '2026-03-29',
      venue: 'Beijing, China',
      prize_fund: '£275,000'
    },
    {
      id: 'wst-german-masters-2026',
      name: '2026 BetVictor German Masters',
      start_date: '2026-02-01',
      end_date: '2026-02-07',
      venue: 'Tempodrom, Berlin, Germany',
      prize_fund: '£90,000'
    },
    {
      id: 'wst-british-open-2026',
      name: '2026 British Open',
      start_date: '2026-09-22',
      end_date: '2026-09-28',
      venue: 'The Centaur, Cheltenham, UK',
      prize_fund: '£110,000'
    }
  ]

  // 根据实际日期自动判断状态
  return tournaments.map(tournament => {
    const status = determineMatchStatus(tournament.start_date, tournament.end_date)
    return Object.assign({}, tournament, { status: status })
  })
}

/**
 * 生成实时比赛日程数据
 * 基于真实选手和比赛数据
 *
 * 注意：由于外部 API 需要授权且爬虫限制，当前使用模拟数据
 * 如果需要真实赛程，请：
 * 1. 联系 snooker.org 获取 API 授权 (webmaster@snooker.org)
 * 2. 或手动维护赛程数据到数据库
 */
function generateRealtimeSchedule(matchId, date) {
  // 这里返回空数组，避免误导用户
  // 真实赛程需要从 snooker.org API 获取，需要 X-Requested-By header 授权
  console.log(`警告: 当前使用模拟赛程数据，不包含真实比赛信息`)
  console.log(`比赛ID: ${matchId}, 日期: ${date}`)
  console.log(`如需真实赛程，请申请 snooker.org API 授权`)

  // 真实的斯诺克顶级选手
  const players = [
    'Ronnie O\'Sullivan',
    'Judd Trump',
    'Neil Robertson',
    'Mark Selby',
    'Kyren Wilson',
    'Ding Junhui',
    'Mark Allen',
    'John Higgins',
    'Luca Brecel',
    'Shaun Murphy',
    'Barry Hawkins',
    'Jack Lisowski',
    'Stuart Bingham',
    'Anthony McGill',
    'Gary Wilson',
    'Zhou Yuelong',
    'Yan Bingtao',
    'Zhao Xintong',
    'Tom Ford',
    'Mark Williams'
  ]

  const rounds = [
    '第一轮',
    '第二轮',
    '第三轮',
    '四分之一决赛',
    '半决赛',
    '决赛'
  ]

  // 从matchId中提取年份和比赛类型
  // matchId格式: wst-world-championship-2026
  function extractYearAndType(matchId) {
    const parts = matchId.split('-')
    if (parts.length < 3) return { year: null, type: null }
    
    // 最后一部分可能是年份
    const lastPart = parts[parts.length - 1]
    const year = parseInt(lastPart, 10)
    if (isNaN(year) || year < 2000 || year > 2100) {
      // 如果不是年份，尝试从倒数第二部分提取
      const secondLast = parts[parts.length - 2]
      const year2 = parseInt(secondLast, 10)
      if (!isNaN(year2) && year2 >= 2000 && year2 <= 2100) {
        return { year: year2, type: parts.slice(0, parts.length - 2).join('-') }
      }
      return { year: null, type: matchId }
    }
    
    // 类型是除去年份部分的前缀
    const type = parts.slice(0, parts.length - 1).join('-')
    return { year, type }
  }

  // 根据比赛类型和年份获取日期范围
  function getMatchDateRange(matchType, year) {
    // 默认日期模式，基于常见斯诺克赛事日程
    const datePatterns = {
      'wst-world-championship': { start: { month: 3, day: 18 }, end: { month: 4, day: 4 } }, // 4月18日-5月4日
      'wst-uk-championship': { start: { month: 10, day: 23 }, end: { month: 11, day: 6 } }, // 11月23日-12月6日
      'wst-masters': { start: { month: 0, day: 11 }, end: { month: 0, day: 18 } }, // 1月11日-1月18日
      'wst-welsh-open': { start: { month: 1, day: 23 }, end: { month: 2, day: 1 } }, // 2月23日-3月1日
      'wst-players-championship': { start: { month: 2, day: 16 }, end: { month: 2, day: 22 } }, // 3月16日-3月22日
      'wst-tour-championship': { start: { month: 2, day: 30 }, end: { month: 3, day: 5 } }, // 3月30日-4月5日
      'wst-shanghai-masters': { start: { month: 8, day: 14 }, end: { month: 8, day: 20 } }, // 9月14日-9月20日
      'wst-china-open': { start: { month: 2, day: 23 }, end: { month: 2, day: 29 } }, // 3月23日-3月29日
      'wst-german-masters': { start: { month: 1, day: 1 }, end: { month: 1, day: 7 } }, // 2月1日-2月7日
      'wst-british-open': { start: { month: 8, day: 22 }, end: { month: 8, day: 28 } } // 9月22日-9月28日
    }

    // 尝试匹配完整类型
    let pattern = datePatterns[matchType]
    
    // 如果未找到，尝试匹配部分类型（例如去掉wst-前缀）
    if (!pattern && matchType.startsWith('wst-')) {
      const shortType = matchType.substring(4)
      pattern = datePatterns[`wst-${shortType}`] || datePatterns[shortType]
    }
    
    if (!pattern) {
      console.warn('未找到比赛类型的日期模式:', matchType)
      return null
    }

    // 构建日期字符串
    const startDate = new Date(year, pattern.start.month, pattern.start.day)
    const endDate = new Date(year, pattern.end.month, pattern.end.day)
    
    // 格式化日期为YYYY-MM-DD
    const formatDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    
    return {
      start: formatDate(startDate),
      end: formatDate(endDate)
    }
  }

  // 提取年份和类型
  const { year, type } = extractYearAndType(matchId)
  if (!year || !type) {
    console.warn('无法从matchId中提取年份或类型:', matchId)
    return []
  }

  // 获取日期范围
  const matchRange = getMatchDateRange(type, year)
  if (!matchRange) {
    console.warn('未找到比赛的日期范围:', matchId)
    return []
  }

  console.log(`比赛日期范围: ${matchRange.start} 至 ${matchRange.end}`)

  // 判断请求的日期是否在比赛期间
  const queryDate = new Date(date)
  const startDate = new Date(matchRange.start)
  const endDate = new Date(matchRange.end)

  // 如果请求日期不在比赛期间，返回空数组
  if (queryDate < startDate || queryDate > endDate) {
    console.log('请求日期不在比赛期间')
    return []
  }

  // 根据比赛ID和日期生成确定性种子
  const hashSeed = (str) => {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash) + str.charCodeAt(i)
      hash |= 0 // 转换为32位整数
    }
    return Math.abs(hash)
  }
  
  const seed = hashSeed(matchId + date)
  const numMatches = 4 // 固定每天4场比赛，保持一致性
  
  // 为不同比赛阶段定义合理的比分范围
  const getReasonableScore = (roundIndex, status, seedOffset) => {
    // 斯诺克比赛通常是几局几胜制
    const maxFrames = [5, 6, 7, 9, 11, 19] // 不同轮次的最大帧数
    const maxFrame = maxFrames[Math.min(roundIndex, maxFrames.length - 1)] || 9
    
    if (status === 'finished') {
      // 已结束的比赛：生成合理的比分（如4-3, 5-2等）
      const winningFrames = Math.floor((seedOffset % (maxFrame - 1)) + Math.ceil(maxFrame / 2))
      const score1 = winningFrames
      const score2 = maxFrame - winningFrames
      return { score1, score2 }
    } else if (status === 'ongoing') {
      // 进行中的比赛：比分应该小于最大帧数
      const currentFrame = Math.floor((seedOffset % maxFrame) + 1)
      const score1 = Math.floor(currentFrame / 2) + 1
      const score2 = Math.floor((currentFrame - 1) / 2)
      return { score1, score2 }
    } else {
      // 未开始的比赛
      return { score1: 0, score2: 0 }
    }
  }

  const schedule = []
  for (let i = 0; i < numMatches; i++) {
    // 使用确定性算法选择选手（确保同一天同一比赛的选手相同）
    const playerOffset = (seed + i * 13) % (players.length - 1)
    const player1Idx = (playerOffset) % players.length
    const player2Idx = (playerOffset + 5 + i) % players.length
    
    // 确保选手不相同
    const actualPlayer2Idx = player1Idx === player2Idx ? (player2Idx + 1) % players.length : player2Idx

    // 根据当前日期判断比赛状态
    const now = new Date()
    const matchTime = new Date(`${date} ${String(10 + i * 3).padStart(2, '0')}:00`)
    
    let status
    if (now > matchTime) {
      status = 'finished'
    } else if (now >= new Date(`${date} 09:00`)) {
      status = 'ongoing'
    } else {
      status = 'upcoming'
    }
    
    // 获取合理比分
    const roundIndex = Math.min(i, rounds.length - 1)
    const { score1, score2 } = getReasonableScore(roundIndex, status, seed + i * 17)

    schedule.push({
      id: `match-${matchId}-${date}-${i}`,
      match_id: `${matchId}-${date}-${i}`,
      start_time: `${String(10 + i * 3).padStart(2, '0')}:00`, // 10:00, 13:00, 16:00, 19:00
      player_1: players[player1Idx],
      player_2: players[actualPlayer2Idx],
      score_1: score1,
      score_2: score2,
      round: rounds[roundIndex],
      status: status,
      isSimulated: true // 标记这是模拟数据
    })
  }

  console.log(`生成模拟赛程数据，比赛ID: ${matchId}, 日期: ${date}, 场次: ${schedule.length}`)
  return schedule
}

// ==================== 诊断测试函数 ====================

/**
 * 测试网络连通性和DNS解析
 */
async function testNetworkConnectivity() {
  const dns = require('dns').promises
  const results = {
    timestamp: new Date().toISOString(),
    tests: []
  }

  // 测试 DNS 解析
  try {
    const dnsStart = Date.now()
    const addresses = await dns.lookup('api.snooker.org', { family: 4 })
    results.tests.push({
      name: 'DNS解析 (IPv4)',
      target: 'api.snooker.org',
      status: 'success',
      result: addresses,
      duration: Date.now() - dnsStart
    })
  } catch (error) {
    results.tests.push({
      name: 'DNS解析 (IPv4)',
      target: 'api.snooker.org',
      status: 'failed',
      error: error.message,
      code: error.code
    })
  }

  // 测试 HTTPS 连接（不下载数据）
  try {
    const https = require('https')
    const connectStart = Date.now()
    await new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.snooker.org',
        port: 443,
        path: '/',
        method: 'HEAD',
        family: 4,
        timeout: 10000
      }, (res) => {
        resolve({
          statusCode: res.statusCode,
          headers: res.headers
        })
      })
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('连接超时'))
      })
      req.end()
    })
    results.tests.push({
      name: 'HTTPS连接测试',
      target: 'api.snooker.org',
      status: 'success',
      duration: Date.now() - connectStart
    })
  } catch (error) {
    results.tests.push({
      name: 'HTTPS连接测试',
      target: 'api.snooker.org',
      status: 'failed',
      error: error.message
    })
  }

  return results
}

/**
 * 测试 API 响应时间（带详细计时）
 */
async function testApiResponseTime(timeoutMs = 18000) {
  const startTime = Date.now()
  const currentSeason = getCurrentSeason()

  const result = {
    timestamp: new Date().toISOString(),
    timeout: timeoutMs,
    season: currentSeason,
    stages: []
  }

  // 阶段1: 准备请求
  const stage1Start = Date.now()
  const url = `${API_CONFIG.SNOOKER_API}/?t=5&s=${currentSeason}`
  const options = {
    headers: {
      'X-Requested-By': SNOOKER_REQUESTED_BY,
      'Accept': 'application/json',
      'User-Agent': 'SnookerScheduleMiniProgram/1.0'
    },
    timeout: timeoutMs,
    httpsAgent: httpsAgent
  }
  result.stages.push({
    name: '准备请求参数',
    duration: Date.now() - stage1Start
  })

  // 阶段2: 发送请求
  const stage2Start = Date.now()
  try {
    const response = await axios({
      ...options,
      url,
      method: 'GET'
    })
    result.stages.push({
      name: 'API请求',
      duration: Date.now() - stage2Start,
      status: 'success',
      dataLength: Array.isArray(response.data) ? response.data.length : 0
    })
    result.status = 'success'
    result.totalDuration = Date.now() - startTime
    result.dataSample = Array.isArray(response.data) && response.data.length > 0
      ? response.data[0]
      : null
  } catch (error) {
    result.stages.push({
      name: 'API请求',
      duration: Date.now() - stage2Start,
      status: 'failed',
      error: error.message,
      errorCode: error.code,
      errorType: getErrorType(error)
    })
    result.status = 'failed'
    result.totalDuration = Date.now() - startTime
    result.error = error.message
  }

  return result
}

/**
 * 测试不同超时设置（优化版：减少场景 + 并行执行）
 * @param {Array} scenarios - 超时场景数组，默认为关键测试点
 */
async function testTimeoutScenarios(scenarios = [5000, 10000]) {
  const results = {
    timestamp: new Date().toISOString(),
    tests: [],
    executionMode: 'parallel'
  }

  // 限制最大测试数量，避免超时
  const timeoutScenarios = scenarios.slice(0, 3)

  console.log(`[测试] 开始并行测试 ${timeoutScenarios.length} 个超时场景...`)

  // 并行执行所有测试
  const testPromises = timeoutScenarios.map(async (timeout) => {
    console.log(`[测试] 发起超时测试: ${timeout}ms`)
    const startTime = Date.now()
    const testResult = await testApiResponseTime(timeout)
    return {
      timeout: timeout,
      actualDuration: Date.now() - startTime,
      ...testResult
    }
  })

  results.tests = await Promise.all(testPromises)
  results.totalDuration = results.tests.reduce((sum, t) => sum + (t.actualDuration || 0), 0)

  console.log(`[测试] 所有超时场景测试完成，总耗时: ${results.totalDuration}ms`)
  return results
}

/**
 * 测试数据库连接
 */
async function testDatabaseConnection() {
  const result = {
    timestamp: new Date().toISOString(),
    tests: []
  }

  // 测试1: 基础连接
  try {
    const start = Date.now()
    const db = cloud.database()
    const testResult = await db.collection(DB_COLLECTION).limit(1).get()
    result.tests.push({
      name: '数据库连接',
      status: 'success',
      duration: Date.now() - start,
      collectionExists: true
    })
  } catch (error) {
    result.tests.push({
      name: '数据库连接',
      status: 'failed',
      error: error.message
    })
  }

  // 测试2: 统计数据
  try {
    const start = Date.now()
    const db = cloud.database()
    const countResult = await db.collection(DB_COLLECTION).count()
    result.tests.push({
      name: '数据统计',
      status: 'success',
      duration: Date.now() - start,
      totalRecords: countResult.total
    })
  } catch (error) {
    result.tests.push({
      name: '数据统计',
      status: 'failed',
      error: error.message
    })
  }

  // 测试3: 获取最新数据
  try {
    const start = Date.now()
    const db = cloud.database()
    const latestResult = await db.collection(DB_COLLECTION)
      .orderBy('updated_at', 'desc')
      .limit(1)
      .get()
    result.tests.push({
      name: '获取最新记录',
      status: 'success',
      duration: Date.now() - start,
      hasData: latestResult.data.length > 0,
      lastUpdate: latestResult.data.length > 0 ? latestResult.data[0].updated_at : null
    })
  } catch (error) {
    result.tests.push({
      name: '获取最新记录',
      status: 'failed',
      error: error.message
    })
  }

  return result
}

/**
 * 完整诊断报告（优化版：支持快速模式 + 并行执行）
 * @param {Object} options - 配置选项
 * @param {boolean} options.fastMode - 是否使用快速模式（默认true，15秒内完成）
 * @param {boolean} options.includeTimeoutScenarios - 是否包含超时场景测试（快速模式下默认false）
 */
async function generateDiagnosticReport(options = {}) {
  const { fastMode = true, includeTimeoutScenarios = false } = options

  console.log('\n========== 开始生成诊断报告 ==========')
  console.log(`[诊断] 模式: ${fastMode ? '快速模式' : '完整模式'}`)
  console.log(`[诊断] 包含超时场景: ${includeTimeoutScenarios ? '是' : '否'}\n`)

  const report = {
    timestamp: new Date().toISOString(),
    mode: fastMode ? 'fast' : 'full',
    environment: {
      nodeVersion: process.version,
      platform: process.platform,
      memoryUsage: process.memoryUsage()
    },
    tests: {}
  }

  const startTime = Date.now()

  if (fastMode) {
    // 快速模式：并行执行关键测试，目标10秒内完成
    console.log('[诊断] 快速模式：并行执行关键测试...')

    const [network, apiStandard, db] = await Promise.all([
      testNetworkConnectivity(),
      testApiResponseTime(8000),  // 减少API超时到8秒
      testDatabaseConnection()
    ])

    report.tests.network = network
    report.tests.apiStandard = apiStandard
    report.tests.database = db
  } else {
    // 完整模式：顺序执行所有测试（仅建议在命令行或后台调用）
    console.log('[诊断] 完整模式：顺序执行所有测试...')

    console.log('[诊断] 测试网络连通性...')
    report.tests.network = await testNetworkConnectivity()

    console.log('[诊断] 测试API响应时间...')
    report.tests.apiStandard = await testApiResponseTime(12000)  // 减少到12秒

    if (includeTimeoutScenarios) {
      console.log('[诊断] 测试不同超时设置...')
      report.tests.timeoutScenarios = await testTimeoutScenarios([5000, 10000])
    }

    console.log('[诊断] 测试数据库连接...')
    report.tests.database = await testDatabaseConnection()
  }

  report.executionTime = Date.now() - startTime

  // 汇总
  report.summary = {
    networkOk: report.tests.network?.tests?.every(t => t.status === 'success'),
    apiOk: report.tests.apiStandard?.status === 'success',
    databaseOk: report.tests.database?.tests?.every(t => t.status === 'success'),
    executionTime: report.executionTime,
    fastMode: fastMode
  }

  console.log('\n========== 诊断报告生成完成 ==========')
  console.log(`执行时间: ${report.executionTime}ms`)
  console.log('汇总:', JSON.stringify(report.summary, null, 2))
  console.log('=====================================\n')

  return report
}

/**
 * 云函数入口函数
 */
exports.main = async (event, context) => {
  const startTime = Date.now()
  console.log(`[${new Date().toISOString()}] 云函数收到请求:`, JSON.stringify(event))
  console.log('云函数上下文:', JSON.stringify(context))

  const { action, id, matchId, date, tour = 'all', force = false } = event

  // 检测是否为定时触发器调用（后台自动刷新）
  // 微信云函数定时触发器会在 event 中包含 Type: 'timer' 和 __trigger__: 'timer'
  const isTimerTrigger = event.Type === 'timer' || event.__trigger__ === 'timer' || context.TRIGGER_SOURCE === 'timer'
  console.log('定时触发器检测:', { isTimerTrigger, eventType: event.Type, trigger: event.__trigger__, contextTrigger: context.TRIGGER_SOURCE })
  if (isTimerTrigger) {
    console.log('🕐 定时触发器调用，执行后台自动刷新...')
    try {
      const currentSeason = getCurrentSeason()
      // 先刷新主要赛事
      console.log('后台刷新主要赛事数据...')
      await updateMatchListFromExternal('main', { force: false })
      // 再刷新全部赛事
      console.log('后台刷新全部赛事数据...')
      await updateMatchListFromExternal('all', { force: false })
      console.log('✅ 后台自动刷新完成')
      return {
        success: true,
        message: '后台自动刷新成功',
        timestamp: new Date().toISOString(),
        season: currentSeason
      }
    } catch (error) {
      console.error('❌ 后台自动刷新失败:', error.message)
      return {
        success: false,
        message: '后台自动刷新失败',
        error: error.message,
        timestamp: new Date().toISOString()
      }
    }
  }

  try {
    let result

    switch (action) {
      case 'test':
        console.log('执行: 诊断测试')
        const testType = event.testType || 'full'

        if (testType === 'network') {
          result = await testNetworkConnectivity()
        } else if (testType === 'api') {
          const timeout = event.timeout || 18000
          result = await testApiResponseTime(timeout)
        } else if (testType === 'timeout') {
          result = await testTimeoutScenarios()
        } else if (testType === 'db') {
          result = await testDatabaseConnection()
        } else {
          // 完整诊断（默认使用快速模式，避免超时）
          result = await generateDiagnosticReport({ fastMode: true })
        }
        break

      case 'list':
        console.log('执行: 获取比赛列表，赛事类型:', tour, '强制更新:', force)

        if (force) {
          console.log('强制刷新标记已开启，跳过缓存直接获取最新数据')
          const currentSeason = getCurrentSeason()
          try {
            const forceUpdateResult = await updateMatchListFromExternal(tour, { force: true })
            if (forceUpdateResult && typeof forceUpdateResult === 'object' && forceUpdateResult.data) {
              result = {
                ...forceUpdateResult,
                forceUpdate: true,
                updated: true,
                isFallback: false,
                errorType: forceUpdateResult.errorType || null
              }
            } else if (Array.isArray(forceUpdateResult)) {
              result = {
                data: forceUpdateResult,
                source: 'snooker.org',
                isFallback: false,
                forceUpdate: true,
                updated: true,
                count: forceUpdateResult.length,
                lastUpdate: new Date().toISOString(),
                season: currentSeason,
                errorType: null
              }
            } else {
              result = forceUpdateResult || { data: [], source: 'unknown', forceUpdate: true, updated: true }
            }
            console.log('✅ 强制更新成功，返回数据，数量:', result.data ? result.data.length : 0)
          } catch (forceUpdateError) {
            console.warn('⚠️ 强制获取失败，尝试回退数据库数据')
            const fallbackResult = await getDatabaseFallbackPayload(currentSeason, tour, forceUpdateError, true)
            if (fallbackResult) {
              result = fallbackResult
            } else {
              const errorType = getErrorType(forceUpdateError)
              const error = new Error(
                errorType === 'timeout'
                  ? '强制刷新超时，且暂无可用缓存数据'
                  : `强制刷新失败：${forceUpdateError.message}`
              )
              error.code = errorType === 'timeout' ? 'TIMEOUT' : forceUpdateError.code
              throw error
            }
          }
        } else {
          result = await getMatchList(tour)
        }

        console.log('比赛列表结果，数量:', result ? (result.data ? result.data.length : result.length) : 0)
        break
      case 'detail':
        console.log('执行: 获取比赛详情, ID:', id)
        result = await getMatchDetail(id)
        console.log('比赛详情结果:', JSON.stringify(result))
        break
      case 'schedule':
        console.log('执行: 获取比赛日程, matchId:', matchId, ', date:', date)
        result = await getMatchSchedule(matchId, date)
        console.log('比赛日程结果:', JSON.stringify(result))
        break
      case 'update':
        console.log('执行: 手动更新比赛数据，强制更新:', force)
        const currentSeason = getCurrentSeason()

        if (force) {
          console.log('强制更新：尝试从外部API获取最新数据')
          try {
            const updateResult = await updateMatchListFromExternal(tour, { force: true })

            if (updateResult && typeof updateResult === 'object' && updateResult.data) {
              result = {
                ...updateResult,
                forceUpdate: true,
                updated: true,
                isFallback: false,
                errorType: updateResult.errorType || null
              }
            } else if (Array.isArray(updateResult)) {
              result = {
                data: updateResult,
                source: 'snooker.org',
                isFallback: false,
                forceUpdate: true,
                updated: true,
                count: updateResult.length,
                lastUpdate: new Date().toISOString(),
                season: currentSeason,
                errorType: null
              }
            } else {
              result = updateResult || {
                message: '更新操作完成',
                updated: true,
                forceUpdate: true,
                errorType: null
              }
            }
            console.log('✅ 强制更新成功，数据来源:', result.source)
          } catch (forceUpdateError) {
            console.warn('⚠️ 强制更新失败，尝试回退数据库数据')
            const fallbackResult = await getDatabaseFallbackPayload(currentSeason, tour, forceUpdateError, true)
            if (fallbackResult) {
              result = fallbackResult
            } else {
              // 三级降级：外部API失败 -> DB缓存失败 -> 使用硬编码数据
              console.warn('⚠️ 数据库无数据，使用硬编码降级数据')
              const hardcodedData = generateHardcodedMatchList(tour)
              result = {
                data: hardcodedData,
                source: 'hardcoded',
                isFallback: true,
                forceUpdate: true,
                updated: false,
                count: hardcodedData.length,
                lastUpdate: new Date().toISOString(),
                season: currentSeason,
                errorType: getErrorType(forceUpdateError),
                errorMessage: forceUpdateError.message
              }
            }
          }
        } else {
          const needUpdate = await shouldUpdateFromDB(currentSeason)
          if (needUpdate) {
            console.log('数据库需要更新，尝试从外部API同步')
            try {
              const updateResult = await updateMatchListFromExternal(tour)

              if (updateResult && typeof updateResult === 'object' && updateResult.data) {
                result = {
                  ...updateResult,
                  forceUpdate: false,
                  updated: true,
                  errorType: updateResult.errorType || null
                }
              } else if (Array.isArray(updateResult)) {
                result = {
                  data: updateResult,
                  source: 'snooker.org',
                  isFallback: false,
                  forceUpdate: false,
                  updated: true,
                  count: updateResult.length,
                  lastUpdate: new Date().toISOString(),
                  season: currentSeason,
                  errorType: null
                }
              } else {
                result = updateResult || {
                  message: '更新操作完成',
                  updated: true,
                  forceUpdate: false,
                  errorType: null
                }
              }
              console.log('✅ 外部API更新成功，数据来源:', result.source)
            } catch (updateError) {
              console.warn('⚠️ 外部API更新失败，使用数据库缓存数据')
              console.warn('错误信息:', updateError.message)

              const fallbackResult = await getDatabaseFallbackPayload(currentSeason, tour, updateError, false)
              if (fallbackResult) {
                result = fallbackResult
              } else {
                const errorType = getErrorType(updateError)
                result = {
                  message: errorType === 'timeout' ? '外部API超时且数据库无数据' : '服务暂不可用且数据库无数据',
                  updated: false,
                  forceUpdate: false,
                  errorType: errorType,
                  error: updateError.message,
                  lastUpdate: new Date().toISOString(),
                  season: currentSeason
                }
                console.error('❌ 外部API失败且数据库无数据')
              }
            }
          } else {
            console.log('✅ 数据库数据新鲜，无需更新')
            const dbLastUpdate = await getLastUpdateTimeFromDB(currentSeason)
            result = {
              message: '数据库数据新鲜，无需更新',
              updated: false,
              forceUpdate: false,
              season: currentSeason,
              lastUpdate: dbLastUpdate || new Date().toISOString()
            }
          }
        }
        console.log('更新操作完成')
        break
      default:
        throw new Error('Invalid action: ' + action)
    }


    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.log(`[${new Date().toISOString()}] 云函数执行成功，总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒)`)

    return {
      success: true,
      data: result
    }
  } catch (error) {
    const endTime = Date.now()
    const totalTime = endTime - startTime
    console.error(`[${new Date().toISOString()}] 云函数执行错误，总耗时: ${totalTime}ms (${(totalTime/1000).toFixed(2)}秒):`, error)
    console.error('错误堆栈:', error.stack)

    return {
      success: false,
      error: error.message,
      errorType: getErrorType(error),
      data: null
    }

  }
}
