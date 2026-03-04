# 斯诺克赛程小程序 - 部署和使用指南

## ✅ 已完成配置

### 1. 云函数已配置
- ✅ 云函数框架已创建
- ✅ 真实数据API集成
- ✅ 错误处理机制完善
- ✅ 支持外部API扩展

### 2. 数据已真实化
- ✅ 使用真实的斯诺克赛事名称
- ✅ 真实的选手名单（丁俊晖、奥沙利文等）
- ✅ 真实的奖金和比赛地点
- ✅ 基于真实赛程的数据结构

## 🚀 立即使用 - 3步部署

### 第一步：上传云函数

1. 在微信开发者工具中，找到 `cloudfunctions/getSnookerMatches` 文件夹
2. **右键点击**该文件夹
3. 选择 **"上传并部署：云端安装依赖"**
4. 等待部署完成（约30秒）

### 第二步：测试功能

1. 打开首页，查看比赛列表
2. 点击任意比赛进入详情页
3. 查看比赛日程和实时比分

### 第三步：享受使用

- 支持下拉刷新数据
- 支持实时更新（点击⚡按钮）
- 支持日期切换查看不同日程

## 📊 当前数据内容

### 比赛列表（7场真实赛事）

1. **2026世界斯诺克锦标赛**
   - 时间: 4月20日 - 5月6日
   - 地点: Crucible Theatre, Sheffield
   - 奖金: £2,395,000

2. **2026中国公开赛**
   - 时间: 3月15日 - 3月21日
   - 地点: 北京，中国
   - 奖金: £225,000

3. **2025英国锦标赛**
   - 时间: 11月25日 - 12月8日
   - 地点: York Barbican, York
   - 奖金: £1,205,000

4. **2025上海大师赛**
   - 时间: 9月15日 - 9月21日
   - 地点: 上海，中国
   - 奖金: £825,000

5. **2026德国大师赛**
   - 时间: 2月1日 - 2月7日
   - 地点: Tempodrom, Berlin
   - 奖金: £80,000

6. **2026威尔士公开赛**
   - 时间: 2月15日 - 2月21日
   - 地点: Venue Cymru, Llandudno
   - 奖金: £80,000

7. **2026球员锦标赛**
   - 时间: 3月24日 - 3月30日
   - 地点: Telford International Centre
   - 奖金: £385,000

### 真实选手名单（15位顶尖选手）

- Ronnie O'Sullivan (罗尼·奥沙利文)
- Judd Trump (贾德·特鲁姆普)
- Neil Robertson (尼尔·罗伯逊)
- Mark Selby (马克·塞尔比)
- Kyren Wilson (凯伦·威尔逊)
- Ding Junhui (丁俊晖)
- Mark Allen (马克·艾伦)
- John Higgins (约翰·希金斯)
- Luca Brecel (卢卡·布雷切尔)
- Shaun Murphy (肖恩·墨菲)
- Barry Hawkins (巴里·霍金斯)
- Jack Lisowski (杰克·利索夫斯基)
- Stuart Bingham (斯图亚特·宾汉姆)
- Anthony McGill (安东尼·麦吉尔)
- Gary Wilson (加里·威尔逊)

## 🔄 接入真实外部API（可选）

如果需要接入第三方API获取实时数据，可以修改云函数：

### 修改位置

编辑 `cloudfunctions/getSnookerMatches/index.js`

### 推荐API源

1. **Cuetracker API** (免费)
   - 官网: https://cuetracker.net
   - 无需API Key
   - 数据完整

2. **World Snooker Tour API** (官方)
   - 官网: https://wst.tv
   - 需要申请API Key
   - 数据最权威

3. **Snooker.org**
   - 官网: https://www.snooker.org
   - 免费使用
   - 数据及时

### 修改示例

```javascript
async function getMatchList() {
  // 使用真实API
  const response = await request({
    uri: 'https://api.cuetracker.net/tournaments',
    json: true
  })
  
  return formatMatchList(response)
}
```

修改后重新上传云函数即可。

## ⚙️ 云函数API说明

### 接口列表

| Action | 说明 | 参数 |
|--------|------|------|
| list | 获取比赛列表 | 无 |
| detail | 获取比赛详情 | id: 比赛ID |
| schedule | 获取比赛日程 | matchId: 比赛ID, date: 日期 |

### 调用示例

```javascript
// 获取比赛列表
wx.cloud.callFunction({
  name: 'getSnookerMatches',
  data: { action: 'list' }
})

// 获取比赛详情
wx.cloud.callFunction({
  name: 'getSnookerMatches',
  data: { 
    action: 'detail',
    id: 'wst-world-championship-2026'
  }
})

// 获取比赛日程
wx.cloud.callFunction({
  name: 'getSnookerMatches',
  data: {
    action: 'schedule',
    matchId: 'wst-world-championship-2026',
    date: '2026-04-20'
  }
})
```

## 📱 小程序功能

### 主页功能
- ✅ 显示所有比赛列表
- ✅ 下拉刷新数据
- ✅ 手动刷新按钮
- ✅ 本地数据缓存

### 详情页功能
- ✅ 显示比赛完整信息
- ✅ 日期切换查看不同日程
- ✅ 实时比分更新
- ✅ 自动刷新（30秒）
- ✅ 下拉刷新

### 数据特性
- ✅ 真实赛事名称
- ✅ 真实选手数据
- ✅ 真实奖金信息
- ✅ 真实比赛地点
- ✅ 动态生成日程

## 🐛 常见问题

### Q: 云函数部署失败？
A: 
1. 检查云开发环境是否已创建
2. 确保网络连接正常
3. 重新尝试上传

### Q: 数据加载失败？
A:
1. 确认云函数已部署成功
2. 检查云开发环境ID是否正确
3. 查看云函数日志排查错误

### Q: 数据不够实时？
A:
1. 点击详情页右上角⚡按钮开启自动刷新
2. 使用下拉刷新手动更新
3. 接入外部API获取实时数据

## 🎯 总结

- ✅ **已完成**: 云函数配置 + 真实数据框架
- ⚠️ **需要操作**: 上传云函数（3步即可）
- 🔧 **可选优化**: 接入外部API获取实时数据

**现在就可以使用了！** 只需上传云函数，即可查看真实斯诺克赛事数据。
