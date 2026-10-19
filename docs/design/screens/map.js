// Shared MapLibre renderer, OpenFreeMap Positron recoloured with qloo.com geo tokens
window.renderMap=function(opt){
  const C={land:'#f8f4f0',park:'#cfdcc6',water:'#d7e1e8',building:'#e7e2dd',road:'#ffffff',minor:'#ffffff',casing:'#e8e3dd',label:'#505a64'};
  const map=new maplibregl.Map({container:'map',style:'https://tiles.openfreemap.org/styles/positron',center:opt.center,zoom:opt.zoom,pitch:opt.pitch||0,bearing:opt.bearing||0,interactive:false,attributionControl:false,fadeDuration:0,preserveDrawingBuffer:true});
  map.on('style.load',()=>{
    const st=map.getStyle();
    for(const l of st.layers){
      const id=l.id;
      try{
      if(l.type==='background')map.setPaintProperty(id,'background-color',C.land);
      else if(id==='park'||id==='landcover_wood')map.setPaintProperty(id,'fill-color',C.park),map.setPaintProperty(id,'fill-opacity',1);
      else if(id==='water')map.setPaintProperty(id,'fill-color',C.water);
      else if(id==='waterway')map.setPaintProperty(id,'line-color',C.water);
      else if(id==='landuse_residential')map.setPaintProperty(id,'fill-color',C.land);
      else if(id==='building')map.setLayoutProperty(id,'visibility','none');
      else if(l.type==='line'&&/casing/.test(id))map.setPaintProperty(id,'line-color',C.casing);
      else if(l.type==='line'&&/highway_(major|motorway)_(inner|subtle)/.test(id))map.setPaintProperty(id,'line-color',C.road);
      else if(l.type==='line'&&/highway_(minor|path)/.test(id))map.setPaintProperty(id,'line-color',C.road);
      else if(l.type==='line'&&/railway|boundary/.test(id))map.setLayoutProperty(id,'visibility','none');
      else if(l.type==='symbol'){
        if(/shield|airport|label_country|label_state/.test(id))map.setLayoutProperty(id,'visibility','none');
        else{map.setPaintProperty(id,'text-color',C.label);map.setPaintProperty(id,'text-halo-color','#f8f4f0');}
      }}catch(e){}
    }
    map.addLayer({id:'b3d',type:'fill-extrusion',source:'openmaptiles','source-layer':'building',minzoom:13,paint:{'fill-extrusion-color':C.building,'fill-extrusion-height':['*',0.45,['coalesce',['get','render_height'],8]],'fill-extrusion-base':['coalesce',['get','render_min_height'],0],'fill-extrusion-opacity':.75}},'highway-name-path');
    if(opt.fit){const b=new maplibregl.LngLatBounds();opt.fit.forEach(p=>b.extend(p));const cam=map.cameraForBounds(b,{padding:opt.pad,bearing:opt.bearing||0});map.jumpTo({center:cam.center,zoom:cam.zoom-(opt.zoomOut||0.1),bearing:opt.bearing||0,pitch:opt.pitch||0});}
    (opt.routes||[]).forEach((r,i)=>{
      map.addSource('r'+i,{type:'geojson',data:{type:'Feature',geometry:{type:'LineString',coordinates:r.coords}}});
      if(r.ghost){map.addLayer({id:'r'+i,type:'line',source:'r'+i,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#a0aab4','line-width':4,'line-dasharray':[0.1,2],'line-opacity':.8}});return;}
      map.addLayer({id:'r'+i+'c',type:'line',source:'r'+i,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':'#ffffff','line-width':10}});
      map.addLayer({id:'r'+i,type:'line',source:'r'+i,layout:{'line-cap':'round','line-join':'round'},paint:{'line-color':r.color||'#8c8cc8','line-width':5.5}});
    });
    (opt.pins||[]).forEach(p=>{
      const el=document.createElement('div');el.className='pin '+(p.cls||'');el.style.setProperty('--c',p.color||'#8c8cc8');
      el.innerHTML=`<div class="bubble"><i></i>${p.n}</div><div class="stem"></div>${p.label?`<div class="label">${p.label}</div>`:''}`;
      new maplibregl.Marker({element:el,anchor:'bottom',offset:[0,p.label?22:0]}).setLngLat(p.ll).addTo(map);
    });
    if(opt.user){const el=document.createElement('div');el.className='user';el.innerHTML='<div class="halo"></div><div class="cone"></div><div class="pulse"></div><div class="core"></div>';new maplibregl.Marker({element:el,pitchAlignment:'map'}).setLngLat(opt.user).addTo(map);}
  });
  map.once('idle',()=>setTimeout(()=>document.body.dataset.ready='1',300));
  window._map=map;
};
