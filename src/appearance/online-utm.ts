/** WGS84 transverse Mercator; the public Sentinel COGs use EPSG:326xx/327xx. */
const A=6378137,E2=.0066943799901413165,K=.9996,RAD=Math.PI/180;
export function projectUtm(lat:number,lon:number,epsg:number):{x:number;y:number} {
  const north=epsg>=32601&&epsg<=32660,zone=epsg-(north?32600:32700);
  const phi=lat*RAD,lambda=(lon-(zone*6-183))*RAD;
  const sin=Math.sin(phi),cos=Math.cos(phi),tan=Math.tan(phi),ep=E2/(1-E2);
  const n=A/Math.sqrt(1-E2*sin*sin),t=tan*tan,c=ep*cos*cos,a=cos*lambda;
  const e4=E2*E2,e6=e4*E2;
  const m=A*((1-E2/4-3*e4/64-5*e6/256)*phi
    -(3*E2/8+3*e4/32+45*e6/1024)*Math.sin(2*phi)
    +(15*e4/256+45*e6/1024)*Math.sin(4*phi)-(35*e6/3072)*Math.sin(6*phi));
  const x=500000+K*n*(a+(1-t+c)*a**3/6+(5-18*t+t*t+72*c-58*ep)*a**5/120);
  const y=(north?0:10000000)+K*(m+n*tan*(a*a/2+(5-t+9*c+4*c*c)*a**4/24
    +(61-58*t+t*t+600*c-330*ep)*a**6/720));
  return {x,y};
}
