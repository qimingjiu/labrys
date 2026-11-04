import type {Tool} from '../types.ts';
const s={type:'string'},strings={type:'array',items:s};const p=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,required,additionalProperties:false});
const tool=(name:string,description:string,parameters:unknown):Tool=>({type:'function',function:{name,description,parameters}});
export const COLLECTION_TOOLS:Tool[]=[
  tool('diary_schedule','用户明确要求每日日记时登记按时区每天写日记，默认23:55、Asia/Shanghai。日记取当天当前房间对本成员可见的原话，区分说话者，不替代家庭记忆。可随计划修改/关闭。',p({time:s,timeZone:s,instruction:s,destination:s,deliveryKind:{enum:['text','file']}},[])),
  tool('diary_write','用户要求时在后台补写指定日期的每日日记，默认今天；返回计划ID，完成后保存Markdown与原话来源。不是网页摘要。',p({date:s,timeZone:s,instruction:s,destination:s,deliveryKind:{enum:['text','file']}},[])),
  tool('toolbox_save','把用户提供的网址、图片或文件收进当前房间的工具箱，立即保存，后台阅读分类。只接受本轮用户提供的网址、上传文件或用户明确给出的文件ID。相同文件内容/规范网址去重，保留原文件和来源。',p({urls:strings,artifactIds:strings,note:s},[])),
  tool('toolbox_search','按自然语言描述、标签或分类查找之前保存的东西，返回若干候选的标题、说明、标签、原网址和文件ID。比如“安卓手机开源项目”。查询本地索引，不重新搜索互联网。',p({query:s,category:{enum:['front_end','tools','resources','other']}},[])),
  tool('toolbox_get','按工具箱条目ID读取完整记录，核对来源、分类和附件。原附件可用现有 delivery_send 发到用户指定的TG/QQ/DC/微信。',p({itemId:s},['itemId'])),
  tool('toolbox_update','按用户要求修正收藏标题、说明、标签、四类分类，删除索引条目或重新读取。删除只隐藏条目，原文件和来源仍保留。',p({itemId:s,patch:p({title:s,description:s,category:{enum:['front_end','tools','resources','other']},tags:strings,deleted:{type:'boolean'},reinspect:{type:'boolean'}})},['itemId','patch'])),
  tool('toolbox_organize','用户明确要求时立即整理当前授权空间的工具箱，合并确切重复的内容引用，保留来源和原文件；不会凭相似说明删除不同项目。',p({})),
  tool('feature_install','用户要求新增功能时，可直接热加载一个受限声明式数据处理工具，无需重启。支持pick/filter/map/sort/unique/limit/aggregate/template，不运行任意代码、网络、Shell或文件操作。必须提供对象参数schema与1–10个输入/预期输出示例，全部通过才启用。新工具自动注册ext_前缀。超出能力用feature_defer，不谎称已安装。',p({name:s,description:s,parameters:{type:'object'},steps:{type:'array',minItems:1,maxItems:30,items:{type:'object',properties:{op:{enum:['pick','filter','map','sort','unique','limit','aggregate','template']},path:s,field:s,operator:{enum:['eq','includes','gte','lte']},value:{},fields:{type:'object',additionalProperties:s},descending:{type:'boolean'},count:{type:'integer'},kind:{enum:['count','sum','average','min','max']},text:s,join:s},required:['op'],additionalProperties:false}},examples:{type:'array',minItems:1,maxItems:10,items:p({input:{},expected:{}},['input','expected'])}},['name','description','parameters','steps','examples'])),
  tool('feature_defer','本轮用户要加的功能无法用当前工具或安全扩展完成时，保存真实需求、具体卡点、验收条件，生成待开发Markdown交接文件，供用户之后叫来的agent读取；状态是pending，不能声称已实现。',p({name:s,reason:s,acceptance:strings},['name','reason','acceptance'])),
  tool('feature_list','查看当前空间的已启用、已停用或待开发功能。只有enabled是真正可用的扩展。',p({status:{enum:['enabled','disabled','pending']}})),
  tool('feature_handoff','将尚未完成的功能需求导出为最新Markdown交接文件，供开发agent读取或按用户要求发到指定平台。',p({})),
  tool('feature_disable','用户明确要求时停用一个自己的扩展。',p({featureId:s},['featureId'])),
];
export const COLLECTION_NAMES=new Set(COLLECTION_TOOLS.map(t=>t.function.name));
