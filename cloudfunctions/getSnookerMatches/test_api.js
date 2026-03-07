// test_api.js - snooker.org 官方API测试脚本
const request = require('request-promise-native')

const API_KEY = 'StarWeChat261'
const BASE_URL = 'https://api.snooker.org'

// 通用请求函数（复用云函数中的逻辑）
async function fetchOfficialAPI(endpoint, params = {}) {
  let url = BASE_URL
  
  // 构建URL
  if (endpoint === 'events') {
    // t=5 获取赛事列表，s=赛季年份
    const season = params.season || 2025
    url = `${url}/?t=5&s=${season}`
  } else if (endpoint === 'event_detail') {
    // t=6 获取赛事详情，e=赛事ID
    const eventId = params.eventId
    if (!eventId) throw new Error('需要 eventId 参数')
    url = `${url}/?t=6&e=${eventId}`
  } else if (endpoint === 'players') {
    // t=2 获取球员列表
    url = `${url}/?t=2`
  } else if (endpoint === 'rankings') {
    // t=9 获取世界排名
    url = `${url}/?t=9`
  } else {
    throw new Error('不支持的端点: ' + endpoint)
  }
  
  const options = {
    uri: url,
    json: true,
    headers: {
      'User-Agent': 'SnookerScheduleMiniProgram/1.0',
      'Accept': 'application/json',
      'X-Requested-By': API_KEY
    },
    timeout: 10000,
    resolveWithFullResponse: true
  }
  
  console.log('🚀 测试请求:', url)
  console.log('📋 请求头:', JSON.stringify(options.headers, null, 2))
  
  const startTime = Date.now()
  try {
    const response = await request(options)
    const endTime = Date.now()
    
    console.log('✅ 请求成功!')
    console.log('⏱️  响应时间:', endTime - startTime, 'ms')
    console.log('📊 状态码:', response.statusCode)
    console.log('📦 数据长度:', Array.isArray(response.body) ? response.body.length : '非数组')
    
    // 显示部分数据样本
    if (Array.isArray(response.body) && response.body.length > 0) {
      console.log('📋 第一项数据样本:')
      console.log(JSON.stringify(response.body[0], null, 2))
      
      // 显示字段结构
      console.log('🔍 字段结构:')
      const sample = response.body[0]
      Object.keys(sample).forEach(key => {
        console.log(`  - ${key}: ${typeof sample[key]} (示例: ${JSON.stringify(sample[key]).substring(0, 50)}...)`)
      })
    }
    
    return {
      success: true,
      data: response.body,
      responseTime: endTime - startTime,
      count: Array.isArray(response.body) ? response.body.length : 1
    }
    
  } catch (error) {
    const endTime = Date.now()
    console.error('❌ 请求失败!')
    console.error('⏱️  失败时间:', endTime - startTime, 'ms')
    console.error('📛 错误信息:', error.message)
    console.error('🔢 状态码:', error.statusCode || '无')
    console.error('🔗 请求URL:', url)
    
    return {
      success: false,
      error: error.message,
      statusCode: error.statusCode,
      responseTime: endTime - startTime
    }
  }
}

// 运行所有测试
async function runAllTests() {
  console.log('='.repeat(60))
  console.log('🎯 snooker.org 官方API测试开始')
  console.log('='.repeat(60))
  console.log(`API Key: ${API_KEY}`)
  console.log(`Base URL: ${BASE_URL}`)
  console.log('')
  
  const results = []
  
  // 测试1: 赛事列表
  console.log('📋 测试1: 获取赛事列表 (t=5, s=2025)')
  console.log('-'.repeat(40))
  const test1 = await fetchOfficialAPI('events', { season: 2025 })
  results.push({ name: '赛事列表', ...test1 })
  console.log('')
  
  // 测试2: 球员列表
  console.log('👥 测试2: 获取球员列表 (t=2)')
  console.log('-'.repeat(40))
  const test2 = await fetchOfficialAPI('players')
  results.push({ name: '球员列表', ...test2 })
  console.log('')
  
  // 测试3: 世界排名
  console.log('🏆 测试3: 获取世界排名 (t=9)')
  console.log('-'.repeat(40))
  const test3 = await fetchOfficialAPI('rankings')
  results.push({ name: '世界排名', ...test3 })
  console.log('')
  
  // 测试4: 如果有赛事ID，测试赛事详情
  if (test1.success && test1.data && test1.data.length > 0) {
    const firstEventId = test1.data[0].ID || test1.data[0].id
    if (firstEventId) {
      console.log('🔍 测试4: 获取赛事详情 (t=6)')
      console.log('-'.repeat(40))
      console.log(`使用第一个赛事的ID: ${firstEventId}`)
      const test4 = await fetchOfficialAPI('event_detail', { eventId: firstEventId })
      results.push({ name: '赛事详情', ...test4 })
      console.log('')
    }
  }
  
  // 输出总结报告
  console.log('='.repeat(60))
  console.log('📊 测试总结报告')
  console.log('='.repeat(60))
  
  results.forEach((result, index) => {
    console.log(`${index + 1}. ${result.name}:`)
    console.log(`   ✅ 状态: ${result.success ? '成功' : '失败'}`)
    if (result.success) {
      console.log(`   ⏱️  响应时间: ${result.responseTime}ms`)
      console.log(`   📦 数据数量: ${result.count}`)
    } else {
      console.log(`   ❌ 错误: ${result.error}`)
      console.log(`   🔢 状态码: ${result.statusCode || '无'}`)
    }
    console.log('')
  })
  
  // 计算成功率
  const successCount = results.filter(r => r.success).length
  const totalCount = results.length
  const successRate = (successCount / totalCount * 100).toFixed(1)
  
  console.log('📈 总体统计:')
  console.log(`   成功: ${successCount}/${totalCount} (${successRate}%)`)
  console.log(`   平均响应时间: ${Math.round(results.reduce((sum, r) => sum + r.responseTime, 0) / results.length)}ms`)
  console.log('='.repeat(60))
  
  // 给出建议
  if (successCount === totalCount) {
    console.log('🎉 所有测试通过！可以安全切换到官方API。')
  } else if (successCount > 0) {
    console.log('⚠️  部分测试失败，需要检查失败的接口。')
  } else {
    console.log('❌ 所有测试失败，请检查：')
    console.log('   1. 网络连接是否可以访问 api.snooker.org')
    console.log('   2. API Key (X-Requested-By头) 是否正确')
    console.log('   3. 官方API服务是否正常')
  }
}

// 执行测试
runAllTests().catch(console.error)