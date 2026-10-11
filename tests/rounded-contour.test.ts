import test from 'node:test';
import assert from 'node:assert/strict';
import { roundedRectanglePolygon, roundedRegularPolygon } from '../src/vendor/trailprint/rounded-footprint.js';

test('圆角矩形包含全部切点，长直边不会被误切成斜边',()=>{
  const points=roundedRectanglePolygon(60,40,20);
  for(const [x,y] of [[40,-40],[60,-20],[60,20],[40,40],[-40,40],[-60,20],[-60,-20],[-40,-40]])
    assert.ok(points.some(p=>Math.hypot(p.x-x,p.y-y)<1e-8),`missing tangent ${x},${y}`);
  const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p.x*q.y-p.y*q.x;},0)/2;
  assert.ok(Math.abs(area-(120*80-(4-Math.PI)*20*20))<10);
});

test('最大圆角矩形和三角形轮廓没有重复的连接点',()=>{
  for(const points of [roundedRectanglePolygon(60,40,40),roundedRectanglePolygon(40,40,40),roundedRegularPolygon(3,60,30)])
    for(let i=0;i<points.length;i++)assert.ok(Math.hypot(points[i].x-points[(i+1)%points.length].x,points[i].y-points[(i+1)%points.length].y)>1e-8);
});
