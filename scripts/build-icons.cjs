const fs=require('fs'),path=require('path');
const sharp=require(process.env.SHARP_MODULE || 'sharp');
const icons=require('./icon-paths.json');
const colors={blue:'#0071e3',muted:'#64748b',white:'#ffffff',green:'#3f8563',red:'#c43b37',brown:'#806448'};
const selected=process.argv.slice(2);
(async()=>{for(const [name,body] of Object.entries(icons).filter(([name])=>!selected.length||selected.includes(name)))for(const [tone,color] of Object.entries(colors)){
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72" viewBox="0 0 24 24" color="${color}" fill="none" stroke="${color}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
await sharp(Buffer.from(svg)).png().toFile(path.join(__dirname,'../assets/icons',`${name}-${tone}.png`));}console.log('Generated native icon assets.');})();
