'use client';

import { useEffect, useState, useRef } from 'react';

export default function CustomCursor() {
  const [position, setPosition] = useState({ x: -100, y: -100 });
  const [follower, setFollower] = useState({ x: -100, y: -100 });
  const [isHovered, setIsHovered] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const mouseRef = useRef({ x: -100, y: -100 });
  const followerRef = useRef({ x: -100, y: -100 });
  const requestRef = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const isMobile = window.matchMedia('(max-width: 768px)').matches;
    if (isMobile) return;

    const handleMouseMove = (e: MouseEvent) => {
      mouseRef.current = { x: e.clientX, y: e.clientY };
      setPosition({ x: e.clientX, y: e.clientY });
      if (!isVisible) setIsVisible(true);

      const target = e.target as HTMLElement;
      if (target) {
        const computedStyle = window.getComputedStyle(target);
        const hasPointer = computedStyle.cursor === 'pointer';
        const isClickableTag = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName);
        const isClickableRole = target.getAttribute('role') === 'button' || target.closest('button') !== null;
        
        setIsHovered(hasPointer || isClickableTag || isClickableRole);
      }
    };

    const handleMouseLeave = () => {
      setIsVisible(false);
    };

    const handleMouseEnter = () => {
      setIsVisible(true);
    };

    window.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseleave', handleMouseLeave);
    document.addEventListener('mouseenter', handleMouseEnter);

    let vx = 0;
    let vy = 0;
    const stiffness = 0.08;
    const damping = 0.65;

    const animateFollower = () => {
      const targetX = mouseRef.current.x;
      const targetY = mouseRef.current.y;
      
      const currentX = followerRef.current.x;
      const currentY = followerRef.current.y;
      
      // Spring physics formula: Accel = (Target - Pos) * Stiffness
      const ax = (targetX - currentX) * stiffness;
      const ay = (targetY - currentY) * stiffness;
      
      // Velocity = (Velocity + Accel) * Damping
      vx = (vx + ax) * damping;
      vy = (vy + ay) * damping;
      
      // Position = Position + Velocity
      const nextX = currentX + vx;
      const nextY = currentY + vy;
      
      followerRef.current = { x: nextX, y: nextY };
      setFollower({ x: nextX, y: nextY });
      
      requestRef.current = requestAnimationFrame(animateFollower);
    };

    requestRef.current = requestAnimationFrame(animateFollower);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseleave', handleMouseLeave);
      document.removeEventListener('mouseenter', handleMouseEnter);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <>
      <div
        className={`custom-cursor-dot ${isHovered ? 'custom-cursor-dot--hover' : ''}`}
        style={{
          left: `${position.x}px`,
          top: `${position.y}px`,
        }}
      />
      <div
        className={`custom-cursor-follower ${isHovered ? 'custom-cursor-follower--hover' : ''}`}
        style={{
          left: `${follower.x}px`,
          top: `${follower.y}px`,
        }}
      />
    </>
  );
}
