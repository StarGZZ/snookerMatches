# Snooker.org API 更新说明

## 已完成的修改

根据用户提供的PowerShell脚本，我已经将snooker.org API调用逻辑集成到微信小程序中。具体修改如下：

### 1. 云函数修改 (`cloudfunctions/getSnookerMatches/index.js`)

#### API端点更新
- 将API端点从 `https://www.snooker.org/res/index.asp` 更新为 `https://api.snooker.org/`
- 使用正确的API参数：`t=5` 获取赛事列表，`s=赛季年份`

#### 请求头更新
- 添加了正确的请求头，与PowerShell脚本保持一致：
  - `X-Requested-By: StarWeChat261`
  - `Accept: application/json`
  - `User-Agent: SnookerScheduleMiniProgram/1.0`

#### 数据处理优化
- 简化了JSON响应处理逻辑
- 根据`Tour`字段值过滤赛事：
  - `Tour: "main"` - 主要赛事
  - `Tour: "q"` - 资格赛
- 使用统一的赛季计算函数 (`getCurrentSeason`)

### 2. 前端页面修改 (`pages/index/`)

#### 添加测试功能
- 在首页添加了"测试API"按钮
- 点击按钮会调用云函数强制更新数据
- 显示测试结果，包括获取的赛事数量和来源

#### 界面优化
- 添加了按钮组布局，包含"刷新"和"测试API"按钮
- 更新了CSS样式

### 3. 配置文件修复 (`app.json`)
- 删除了错误的页面配置 `"cloudfunctions/getSnookerMatches/test_api.js"`

## 如何使用测试功能

1. 打开小程序，进入首页
2. 点击右上角的"测试API"按钮（🧪图标）
3. 系统会调用snooker.org API获取最新数据
4. 弹出窗口显示测试结果，包括：
   - 获取的赛事数量
   - 数据来源（snooker.org或降级数据）
   - 第一个赛事的名称

## API参数说明

### 赛事列表API
- URL: `https://api.snooker.org/?t=5&s=2025`
- `t=5`: 获取赛事列表
- `s=2025`: 赛季年份（2025赛季）

### 赛事详情API
- URL: `https://api.snooker.org/?t=6&e=赛事ID`
- `t=6`: 获取赛事赛程
- `e=赛事ID`: 赛事ID

## 注意事项

1. **API限制**: snooker.org API有10次/分钟的调用限制，代码中已添加缓存机制
2. **赛季计算**: 斯诺克赛季从8月开始，代码已正确处理赛季年份
3. **降级数据**: 如果API调用失败，会使用内置的降级数据确保应用可用
4. **数据格式**: API返回JSON格式数据，包含ID、Name、StartDate、EndDate、Venue等字段

## 验证方法

1. 点击"测试API"按钮，查看是否能成功获取数据
2. 检查控制台日志，查看详细的API请求和响应信息
3. 对比获取的数据与test_result.json文件中的数据是否一致

## 后续优化建议

1. 如果需要更详细的赛事信息，可以调用`t=6`接口获取赛程
2. 可以考虑添加数据缓存到本地，减少API调用
3. 可以添加错误重试机制，提高API调用成功率
4. 可以添加数据更新时间显示，让用户知道数据的时效性